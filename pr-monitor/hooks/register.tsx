import type { Hook, Register } from 'claude-code'

import {
  type Action,
  type Pr,
  mergeTreeOutcome,
  nextAction,
  otherBranchFiles,
  readiness,
  resolvePrompt,
} from './logic'

type Api = Parameters<Hook<'session.start'>>[0]

const PANE = 'pr-monitor'
const PR_FIELDS =
  'number,title,headRefName,baseRefName,headRefOid,isDraft,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,files'
// Pairwise conflict checks grow as n²; past this many monitored PRs they're skipped.
const MAX_PAIRWISE = 12
// After you change which PRs auto-merge, wait this long so the plan sees the whole set.
const SETTLE_MS = 10_000

type Settings = {
  mergeMethod: 'squash' | 'merge' | 'rebase'
  pollMs: number
  autoOpen: boolean
  maxResolveAttempts: number
}

// Module state rather than $.state, which some engine versions don't provide.
let settings: Settings = { mergeMethod: 'squash', pollMs: 60_000, autoOpen: true, maxResolveAttempts: 2 }
let repo: { root: string; name: string } | null = null
let prs: Pr[] = []
const monitored = new Set<number>()
// Your authorization to merge, per PR. Deliberately not saved between sessions.
const autoMerge = new Set<number>()
let isPaused = false
let isRefreshing = false
let refreshedAt = 0
let lastError: string | null = null
let busy: string | null = null
let resolving: { number: number; oid: string; isTurnDone: boolean } | null = null
const resolveFailures = new Map<number, number>()
const needsYou = new Map<number, string>()
const pairConflicts = new Map<number, Set<number>>()
const pairCache = new Map<string, 'clean' | 'conflicts' | 'error'>()
let pendingStep: { cancel: () => void } | null = null
let settlesAt = 0

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

async function run($: Api, argv: string[], timeoutMs = 30_000) {
  return $.process.run(argv, { cwd: repo?.root, timeoutMs })
}

async function detectRepo($: Api) {
  const root = await $.session.root()
  const result = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    cwd: root,
    timeoutMs: 20_000,
  })
  repo = result.exitCode === 0 && result.stdout.trim() !== '' ? { root, name: result.stdout.trim() } : null
}

async function loadSelections($: Api) {
  if (!repo) return
  try {
    const saved = await $.store.get(`monitored:${repo.name}`)
    if (Array.isArray(saved)) for (const n of saved) if (typeof n === 'number') monitored.add(n)
  } catch {
    // No store on this engine: selections last for the session only.
  }
}

async function saveSelections($: Api) {
  if (!repo) return
  try {
    await $.store.set(`monitored:${repo.name}`, [...monitored])
  } catch {
    // As above.
  }
}

async function fetchRefs($: Api, list: Pr[]) {
  const bases = [...new Set(list.map(pr => pr.baseRefName))]
  const refspecs = [
    ...bases.map(base => `+refs/heads/${base}:refs/remotes/origin/${base}`),
    ...list.map(pr => `+refs/pull/${pr.number}/head:refs/pr-monitor/${pr.number}`),
  ]
  if (refspecs.length === 0) return true
  const result = await run($, ['git', 'fetch', '--quiet', '--no-tags', 'origin', ...refspecs], 120_000)
  if (result.exitCode !== 0) lastError = `git fetch failed: ${firstLine(result.stderr)}`

  return result.exitCode === 0
}

async function computePairs($: Api, list: Pr[]) {
  pairConflicts.clear()
  if (list.length > MAX_PAIRWISE) return
  for (const [i, a] of list.entries()) {
    for (const b of list.slice(i + 1)) {
      const key = [a.headRefOid, b.headRefOid].sort().join(':')
      let outcome = pairCache.get(key)
      if (outcome === undefined) {
        const result = await run($, [
          'git', 'merge-tree', '--write-tree', '--name-only',
          `refs/pr-monitor/${a.number}`, `refs/pr-monitor/${b.number}`,
        ])
        outcome = mergeTreeOutcome(result.exitCode)
        if (outcome !== 'error') pairCache.set(key, outcome)
      }
      if (outcome === 'conflicts') {
        pairConflicts.set(a.number, (pairConflicts.get(a.number) ?? new Set()).add(b.number))
        pairConflicts.set(b.number, (pairConflicts.get(b.number) ?? new Set()).add(a.number))
      }
    }
  }
}

// A resolution is done once the branch moved, or once Claude's turn ended without moving it.
function settleResolving() {
  if (!resolving) return
  const pr = prs.find(one => one.number === resolving?.number)
  if (!pr) {
    resolving = null
  } else if (pr.headRefOid !== resolving.oid) {
    if (pr.mergeable === 'CONFLICTING') resolveFailures.set(pr.number, (resolveFailures.get(pr.number) ?? 0) + 1)
    resolving = null
  } else if (resolving.isTurnDone) {
    resolveFailures.set(pr.number, (resolveFailures.get(pr.number) ?? 0) + 1)
    resolving = null
  }
}

function summarize($: Api) {
  if (!repo || monitored.size === 0) {
    $.ui.status(undefined)
    return
  }
  const watched = prs.filter(pr => monitored.has(pr.number)).map(pr => readiness(pr).kind)
  const ready = watched.filter(kind => kind === 'ready').length
  const conflicts = watched.filter(kind => kind === 'conflicts').length
  $.ui.status(`PRs: ${monitored.size} watched · ${ready} ready${conflicts > 0 ? ` · ${conflicts} conflicting` : ''}`)
}

async function refresh($: Api) {
  if (!repo || isRefreshing) return
  isRefreshing = true
  $.ui.invalidate('ui.render')
  try {
    const listed = await run($, ['gh', 'pr', 'list', '--state', 'open', '--limit', '50', '--json', PR_FIELDS], 60_000)
    if (listed.exitCode !== 0) {
      lastError = `gh pr list failed: ${firstLine(listed.stderr)}`
      return
    }
    prs = JSON.parse(listed.stdout) as Pr[]
    lastError = null

    const open = new Set(prs.map(pr => pr.number))
    for (const set of [monitored, autoMerge]) for (const n of [...set]) if (!open.has(n)) set.delete(n)

    const watched = prs.filter(pr => monitored.has(pr.number))
    if (watched.length > 0 && (await fetchRefs($, watched))) await computePairs($, watched)

    settleResolving()
    refreshedAt = await $.clock.now()
    summarize($)
  } catch (error) {
    lastError = `refresh failed: ${String(error)}`
  } finally {
    isRefreshing = false
    $.ui.invalidate('ui.render')
  }
  await step($)
}

function plan(): Action | null {
  return nextAction({
    prs,
    monitored,
    autoMerge,
    pairConflicts,
    resolveFailures,
    maxResolveAttempts: settings.maxResolveAttempts,
  })
}

async function step($: Api) {
  if (!repo || isPaused || busy !== null || resolving !== null || isRefreshing || pendingStep !== null) return
  const action = plan()
  if (!action) return
  const { pr } = action

  if (action.kind === 'needs-you') {
    needsYou.set(pr.number, action.reason)
    autoMerge.delete(pr.number)
    $.ui.toast(`#${pr.number} needs you: ${action.reason}`)
    $.ui.invalidate('ui.render')
    return
  }

  if (action.kind === 'resolve') {
    resolving = { number: pr.number, oid: pr.headRefOid, isTurnDone: false }
    $.ui.invalidate('ui.render')
    $.ui.toast(`Asking Claude to resolve conflicts on #${pr.number}`)
    await $.prompt.submit({ text: resolvePrompt(pr, repo.name, otherBranchFiles(pr, prs, monitored)) })
    return
  }

  busy = action.kind === 'merge' ? `Merging #${pr.number}…` : `Updating #${pr.number} from ${pr.baseRefName}…`
  $.ui.invalidate('ui.render')
  try {
    const argv =
      action.kind === 'merge'
        ? ['gh', 'pr', 'merge', String(pr.number), `--${settings.mergeMethod}`, '--match-head-commit', pr.headRefOid]
        : ['gh', 'pr', 'update-branch', String(pr.number)]
    const result = await run($, argv, 120_000)
    if (result.exitCode === 0) {
      $.ui.toast(action.kind === 'merge' ? `Merged #${pr.number}` : `Updated #${pr.number} from ${pr.baseRefName}`)
      if (action.kind === 'merge') {
        autoMerge.delete(pr.number)
        monitored.delete(pr.number)
        await saveSelections($)
      }
    } else {
      const why = firstLine(result.stderr) || `exit ${result.exitCode}`
      needsYou.set(pr.number, `${action.kind === 'merge' ? 'merge' : 'update'} failed: ${why}`)
      autoMerge.delete(pr.number)
      $.ui.toast(`#${pr.number}: ${why}`)
    }
  } finally {
    busy = null
    $.ui.invalidate('ui.render')
  }
  // GitHub takes a moment to recompute the other PRs against the new base.
  $.clock.after(5_000, () => void refresh($))
}

function scheduleStep($: Api, at: number) {
  pendingStep?.cancel()
  settlesAt = at + SETTLE_MS
  pendingStep = $.clock.after(SETTLE_MS, () => {
    pendingStep = null
    settlesAt = 0
    void step($)
  })
}

function describe(action: Action | null) {
  if (!action) return autoMerge.size > 0 ? 'Waiting for checks or GitHub' : 'Nothing set to auto-merge'
  switch (action.kind) {
    case 'merge':
      return `Next: merge #${action.pr.number}`
    case 'update-branch':
      return `Next: update #${action.pr.number} from ${action.pr.baseRefName}`
    case 'resolve':
      return `Next: ask Claude to resolve conflicts on #${action.pr.number}`
    case 'needs-you':
      return `#${action.pr.number} needs you`
  }
}

const COLORS: Record<string, string | undefined> = {
  ready: 'green',
  conflicts: 'red',
  'checks-failing': 'red',
  blocked: 'yellow',
  unstable: 'yellow',
  behind: 'yellow',
  'checks-pending': 'cyan',
  computing: 'cyan',
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

export const register: Register = (on, options) => {
  settings = {
    mergeMethod: options.mergeMethod === 'merge' || options.mergeMethod === 'rebase' ? options.mergeMethod : 'squash',
    pollMs: Math.max(20, Number(options.pollSeconds ?? 60)) * 1000,
    autoOpen: options.autoOpen !== false,
    maxResolveAttempts: Math.max(1, Number(options.maxResolveAttempts ?? 2)),
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'pr-monitor', description: 'Open the pull request monitor for this repository' })
      await detectRepo($)
      if (repo) {
        await loadSelections($)
        await refresh($)
        $.clock.every(settings.pollMs, () => void refresh($))
        $.clock.every(1_000, () => $.ui.invalidate('ui.render'))
        if (settings.autoOpen && prs.length > 0) void $.ui.open({ id: PANE, title: 'Pull requests' })
      }
    } catch (error) {
      $.ui.toast(`pr-monitor could not start: ${String(error)}`)
    }

    return next(e)
  })

  on('command.run', { command: 'pr-monitor' }, async $ => {
    if (!repo) await detectRepo($)
    if (!repo) return { text: 'pr-monitor: this directory is not a GitHub repository gh can see.' }
    await $.ui.open({ id: PANE, title: 'Pull requests' })
    void refresh($)

    return { text: `Monitoring pull requests on ${repo.name}.` }
  })

  // The resolution turn ended: the next refresh decides whether it worked.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && resolving) {
      resolving.isTurnDone = true
      $.clock.after(10_000, () => void refresh($))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)

    if (!repo) {
      return <Text dimColor>Not in a GitHub repository gh can see.</Text>
    }

    const now = await $.clock.now()
    const settling = settlesAt > now ? ` (starting in ${Math.ceil((settlesAt - now) / 1000)}s)` : ''
    const status = isPaused
      ? 'Auto-merge paused'
      : busy ?? (resolving ? `Waiting on Claude to resolve #${resolving.number}` : describe(plan()) + settling)
    const ordered = [...prs].sort(
      (a, b) => Number(monitored.has(b.number)) - Number(monitored.has(a.number)) || a.number - b.number,
    )

    const toggleMonitor = async (n: number) => {
      if (monitored.has(n)) {
        monitored.delete(n)
        autoMerge.delete(n)
      } else {
        monitored.add(n)
      }
      await saveSelections($)
      $.ui.invalidate('ui.render')
      void refresh($)
    }

    const toggleAutoMerge = async (n: number) => {
      if (autoMerge.has(n)) autoMerge.delete(n)
      else {
        autoMerge.add(n)
        needsYou.delete(n)
        resolveFailures.delete(n)
      }
      scheduleStep($, now)
      $.ui.invalidate('ui.render')
    }

    const togglePause = async () => {
      isPaused = !isPaused
      $.ui.toast(isPaused ? 'Auto-merge paused' : 'Auto-merge resumed')
      $.ui.invalidate('ui.render')
      await step($)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>{repo.name}</Text>
          <Text dimColor>
            {prs.length} open · {isRefreshing ? 'refreshing…' : refreshedAt > 0 ? `refreshed ${ago(now - refreshedAt)}` : 'not refreshed'}
          </Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void refresh($)} />
          <Button
            key="pause"
            label={isPaused ? 'Resume auto-merge' : 'Pause auto-merge'}
            hotkey="p"
            variant={isPaused ? 'primary' : undefined}
            onPress={togglePause}
          />
        </Box>
        <Text color={isPaused ? 'yellow' : undefined}>{status}</Text>
        {lastError !== null && <Text color="red">{lastError}</Text>}
        {prs.length === 0 && <Text dimColor>No open pull requests.</Text>}
        {ordered.map(pr => {
          const n = pr.number
          const isWatched = monitored.has(n)
          const state = readiness(pr)
          const overlaps = [...(pairConflicts.get(n) ?? [])].sort((a, b) => a - b)
          const flag = needsYou.get(n)

          return (
            <Box key={`pr-${n}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Button key={`watch-${n}`} plain label={isWatched ? '■' : '□'} onPress={() => toggleMonitor(n)} />
                <Text wrap="truncate-end" dimColor={!isWatched}>
                  #{n} {pr.title}
                </Text>
              </Box>
              {isWatched && (
                <Box flexDirection="row" gap={2} marginLeft={2}>
                  <Text color={COLORS[state.kind]}>{state.label}</Text>
                  {overlaps.length > 0 && <Text dimColor>conflicts with {overlaps.map(o => `#${o}`).join(' ')}</Text>}
                  {flag !== undefined && <Text color="red">needs you: {flag}</Text>}
                  <Button
                    key={`auto-${n}`}
                    label={autoMerge.has(n) ? 'Auto-merge when green ✓' : 'Auto-merge when green'}
                    variant={autoMerge.has(n) ? 'primary' : undefined}
                    dimColor={!autoMerge.has(n)}
                    onPress={() => toggleAutoMerge(n)}
                  />
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}

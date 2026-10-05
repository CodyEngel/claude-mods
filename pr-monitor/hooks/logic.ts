// Pure decision logic for pr-monitor: no `$`, no I/O, so tests can drive it directly.

export type Check = {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string | null
  state?: string
}

export type Pr = {
  number: number
  title: string
  headRefName: string
  baseRefName: string
  headRefOid: string
  isDraft: boolean
  isCrossRepository: boolean
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  statusCheckRollup: Check[] | null
  files: { path: string }[] | null
}

export type ChecksState = 'pass' | 'fail' | 'pending' | 'none'

const CHECK_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

// statusCheckRollup mixes CheckRuns (status + conclusion) and StatusContexts (state).
export function checksState(rollup: readonly Check[] | null): ChecksState {
  if (!rollup || rollup.length === 0) return 'none'
  let isPending = false
  for (const check of rollup) {
    if (check.state !== undefined) {
      if (check.state === 'SUCCESS') continue
      if (check.state === 'PENDING' || check.state === 'EXPECTED') isPending = true
      else return 'fail'
    } else if (check.status !== 'COMPLETED') {
      isPending = true
    } else if (!CHECK_OK.has(check.conclusion ?? '')) {
      return 'fail'
    }
  }
  return isPending ? 'pending' : 'pass'
}

export type ReadinessKind =
  | 'draft'
  | 'computing'
  | 'conflicts'
  | 'checks-failing'
  | 'checks-pending'
  | 'behind'
  | 'blocked'
  | 'unstable'
  | 'ready'

export type Readiness = { kind: ReadinessKind; label: string }

export function readiness(pr: Pr): Readiness {
  const checks = checksState(pr.statusCheckRollup)
  if (pr.isDraft) return { kind: 'draft', label: 'draft' }
  // GitHub recomputes after every push or base change; UNKNOWN means "ask again".
  if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN') {
    return { kind: 'computing', label: 'GitHub is checking mergeability' }
  }
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    return { kind: 'conflicts', label: `conflicts with ${pr.baseRefName}` }
  }
  if (checks === 'fail') return { kind: 'checks-failing', label: 'checks failing' }
  if (checks === 'pending') return { kind: 'checks-pending', label: 'checks running' }
  switch (pr.mergeStateStatus) {
    case 'BEHIND':
      return { kind: 'behind', label: `behind ${pr.baseRefName}` }
    case 'BLOCKED':
      return {
        kind: 'blocked',
        label: pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === 'CHANGES_REQUESTED'
          ? `blocked: ${pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : 'review required'}`
          : 'blocked by branch protection',
      }
    // Non-required checks failed. Never auto-merged; shown so you can decide.
    case 'UNSTABLE':
      return { kind: 'unstable', label: 'non-required checks failing' }
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { kind: 'ready', label: 'ready to merge' }
    default:
      return { kind: 'computing', label: `state ${pr.mergeStateStatus.toLowerCase()}` }
  }
}

// Exit code of `git merge-tree --write-tree`: 0 clean, 1 conflicts, anything else an error.
export function mergeTreeOutcome(exitCode: number): 'clean' | 'conflicts' | 'error' {
  return exitCode === 0 ? 'clean' : exitCode === 1 ? 'conflicts' : 'error'
}

export type Action =
  | { kind: 'merge'; pr: Pr }
  | { kind: 'update-branch'; pr: Pr }
  | { kind: 'resolve'; pr: Pr }
  | { kind: 'needs-you'; pr: Pr; reason: string }

export type PlanInput = {
  prs: readonly Pr[]
  monitored: ReadonlySet<number>
  autoMerge: ReadonlySet<number>
  /** For each monitored PR, the other monitored PRs its branch conflicts with. */
  pairConflicts: ReadonlyMap<number, ReadonlySet<number>>
  resolveFailures: ReadonlyMap<number, number>
  maxResolveAttempts: number
}

/**
 * The one next thing to do for the PRs set to auto-merge, or null to wait.
 *
 * Order: merge clean PRs first, fewest conflicts with other monitored branches
 * first, so each merge disturbs as few of them as possible; bring branches that
 * are merely behind up to date; only once nothing else is about to land, resolve
 * a conflicted branch, so it is resolved once against the final base instead of
 * again after every merge.
 */
export function nextAction(input: PlanInput): Action | null {
  const { prs, monitored, autoMerge, pairConflicts, resolveFailures, maxResolveAttempts } = input
  const score = (pr: Pr) => pairConflicts.get(pr.number)?.size ?? 0
  const queue = prs
    .filter(pr => monitored.has(pr.number) && autoMerge.has(pr.number))
    .map(pr => ({ pr, state: readiness(pr) }))
    .sort((a, b) => score(a.pr) - score(b.pr) || a.pr.number - b.pr.number)

  const first = (kind: ReadinessKind) => queue.find(item => item.state.kind === kind)

  const ready = first('ready')
  if (ready) return { kind: 'merge', pr: ready.pr }

  const behind = first('behind')
  if (behind) return { kind: 'update-branch', pr: behind.pr }

  const isLanding = queue.some(item => item.state.kind === 'computing' || item.state.kind === 'checks-pending')
  if (isLanding) return null

  const conflicted = first('conflicts')
  if (!conflicted) return null
  const pr = conflicted.pr
  if (pr.isCrossRepository) {
    return { kind: 'needs-you', pr, reason: 'conflicts on a fork branch, which this mod cannot push to' }
  }
  if ((resolveFailures.get(pr.number) ?? 0) >= maxResolveAttempts) {
    return { kind: 'needs-you', pr, reason: `automatic resolution failed ${maxResolveAttempts} times` }
  }
  return { kind: 'resolve', pr }
}

/** Files each other monitored PR touches, for keeping a resolution out of their way. */
export function otherBranchFiles(pr: Pr, prs: readonly Pr[], monitored: ReadonlySet<number>) {
  return prs
    .filter(other => other.number !== pr.number && monitored.has(other.number))
    .map(other => ({ number: other.number, files: (other.files ?? []).map(file => file.path) }))
    .filter(other => other.files.length > 0)
}

export function resolvePrompt(pr: Pr, repo: string, others: ReturnType<typeof otherBranchFiles>) {
  const slug = `pr-monitor-${pr.number}`
  const touched = others.length === 0
    ? 'No other monitored PRs touch files, so resolve purely on the merits.'
    : [
        'Other monitored PRs touch these files. Keep your resolution as small as possible in them, and do not reformat, reorder or move code there, so those branches do not pick up new conflicts:',
        ...others.map(other => `- #${other.number}: ${other.files.slice(0, 40).join(', ')}${other.files.length > 40 ? ', …' : ''}`),
      ].join('\n')

  return [
    `Resolve the merge conflicts on PR #${pr.number} ("${pr.title}") in ${repo} so it can merge into \`${pr.baseRefName}\`. The pr-monitor mod queued this.`,
    '',
    'Steps:',
    `1. Work in a temporary worktree, never in my checkout: \`git fetch origin ${pr.baseRefName} ${pr.headRefName}\`, then \`git worktree add -B ${slug} "$(mktemp -d)/${slug}" origin/${pr.headRefName}\`.`,
    `2. Merge, don't rebase: \`git merge origin/${pr.baseRefName}\` in that worktree. Never force-push; other people and branches may track this one.`,
    '3. Resolve each conflict keeping the intent of both sides. Change nothing outside the conflicted hunks.',
    "4. If the project has a fast build or test command, run it. Don't start long suites.",
    `5. Commit the merge and push with \`git push origin HEAD:${pr.headRefName}\`.`,
    `6. Remove the worktree and the \`${slug}\` local branch.`,
    '',
    touched,
    '',
    "If you can't resolve a conflict confidently, stop without pushing and say which hunk needs a person.",
  ].join('\n')
}

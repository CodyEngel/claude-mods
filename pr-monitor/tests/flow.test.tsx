import { expect, mock, test } from 'claude-code/testing'

import type { Pr } from '../hooks/logic'

const PASS = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }]
const pr = (number: number, over: Partial<Pr> = {}): Pr => ({
  number,
  title: `PR ${number}`,
  headRefName: `feature-${number}`,
  baseRefName: 'main',
  headRefOid: `sha${number}`,
  isDraft: false,
  isCrossRepository: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  statusCheckRollup: PASS,
  files: [{ path: `src/${number}.ts` }],
  ...over,
})

test('marks, merges the clean PR, then asks Claude to resolve the conflicted one', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  // PR 1 is clean; PR 2 conflicts with main.
  let world: Pr[] = [pr(1), pr(2, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })]
  const commands: string[] = []
  const prompts: string[] = []

  on('session.start', () => ({ cwd: '/repo' }))
  on('session.root', () => ({ value: '/repo' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const line = argv.join(' ')
    commands.push(line)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
    if (line.startsWith('gh repo view')) return ok('acme/widgets\n')
    if (line.startsWith('gh pr list')) return ok(JSON.stringify(world))
    if (line.startsWith('gh pr merge')) {
      const n = Number(argv[3])
      world = world.filter(p => p.number !== n)
      return ok()
    }
    if (line.startsWith('git merge-tree')) return { value: { exitCode: 0, stdout: 'tree\n', stderr: '' } } as never
    return ok()
  })

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const term = await $.ui.mount({ plugin: 'pr-monitor', surface: 'terminal', component: 'Pane', requestId: 'pr-monitor', props: {} } as never)
  expect(await term.find({ key: 'watch-2' })).toBeDefined()
  expect(await term.find({ key: 'pause' })).toBeDefined()
  await term.unmount()
  const ui = await $.ui.mount({ plugin: 'pr-monitor', surface: 'desktop', component: 'Pane', requestId: 'pr-monitor', props: {} } as never)

  expect(await ui.find({ key: 'watch-1' })).toBeDefined()
  await ui.press({ key: 'watch-1' })
  await ui.press({ key: 'watch-2' })
  expect(commands.some(c => c.startsWith('git fetch'))).toBe(true)

  // Nothing merges until you opt PRs in, and not until 10s after the last change.
  await ui.press({ key: 'auto-2' })
  await ui.press({ key: 'auto-1' })
  expect(commands.some(c => c.startsWith('gh pr merge'))).toBe(false)
  expect(prompts).toHaveLength(0)

  // The clean PR merges first, pinned to the head it was judged on.
  await clock.advance(10_000)
  expect(commands.filter(c => c.startsWith('gh pr merge'))).toEqual(['gh pr merge 1 --squash --match-head-commit sha1'])
  expect(prompts).toHaveLength(0)

  // Once the base has moved, the conflicted PR is resolved once, by Claude.
  await clock.advance(5_000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatch(/PR #2/)
  expect(prompts[0]).toMatch(/Never force-push/)

  // Claude pushes a merge commit; GitHub says it's clean; the next refresh merges it.
  world = [pr(2, { headRefOid: 'sha2-resolved' })]
  await clock.advance(60_000)
  expect(commands.filter(c => c.startsWith('gh pr merge'))).toEqual([
    'gh pr merge 1 --squash --match-head-commit sha1',
    'gh pr merge 2 --squash --match-head-commit sha2-resolved',
  ])
  expect(commands.some(c => c.includes('--admin'))).toBe(false)
})

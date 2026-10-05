import { expect, test } from 'claude-code/testing'

import { type Pr, checksState, nextAction, readiness, resolvePrompt } from '../hooks/logic'

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

const plan = (prs: Pr[], pairs: Record<number, number[]> = {}, failures: Record<number, number> = {}) =>
  nextAction({
    prs,
    monitored: new Set(prs.map(p => p.number)),
    autoMerge: new Set(prs.map(p => p.number)),
    pairConflicts: new Map(Object.entries(pairs).map(([k, v]) => [Number(k), new Set(v)])),
    resolveFailures: new Map(Object.entries(failures).map(([k, v]) => [Number(k), v])),
    maxResolveAttempts: 2,
  })

test('checks: CheckRuns and StatusContexts both count', () => {
  expect(checksState(null)).toBe('none')
  expect(checksState(PASS)).toBe('pass')
  expect(checksState([...PASS, { state: 'PENDING' }])).toBe('pending')
  expect(checksState([...PASS, { status: 'IN_PROGRESS', conclusion: null }])).toBe('pending')
  expect(checksState([{ state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('fail')
  expect(checksState([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'ERROR' }])).toBe('fail')
})

test('readiness: UNKNOWN is never treated as clean or conflicting', () => {
  expect(readiness(pr(1, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).kind).toBe('computing')
  expect(readiness(pr(1, { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN' })).kind).toBe('computing')
  expect(readiness(pr(1, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).kind).toBe('conflicts')
  expect(readiness(pr(1, { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })).label).toMatch(/review required/)
  expect(readiness(pr(1, { mergeStateStatus: 'UNSTABLE' })).kind).toBe('unstable')
  expect(readiness(pr(1, { mergeStateStatus: 'BEHIND' })).kind).toBe('behind')
  expect(readiness(pr(1, { mergeStateStatus: 'HAS_HOOKS' })).kind).toBe('ready')
  expect(readiness(pr(1, { isDraft: true })).kind).toBe('draft')
  expect(readiness(pr(1, { statusCheckRollup: [{ state: 'PENDING' }] })).kind).toBe('checks-pending')
})

test('order: the ready PR that conflicts with the fewest other branches merges first', () => {
  const action = plan([pr(1), pr(2), pr(3)], { 1: [2, 3], 2: [1], 3: [1] })
  expect(action?.kind).toBe('merge')
  expect(action?.pr.number).toBe(2)
})

test('order: unstable, blocked and failing PRs are never merged', () => {
  expect(plan([pr(1, { mergeStateStatus: 'UNSTABLE' })])).toBeNull()
  expect(plan([pr(1, { mergeStateStatus: 'BLOCKED' })])).toBeNull()
  expect(plan([pr(1, { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })])).toBeNull()
})

test('order: behind branches are updated before any conflict is resolved', () => {
  const action = plan([pr(1, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), pr(2, { mergeStateStatus: 'BEHIND' })])
  expect(action?.kind).toBe('update-branch')
  expect(action?.pr.number).toBe(2)
})

test('order: conflicts wait until nothing else is about to land, then resolve once', () => {
  const conflicted = pr(1, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
  expect(plan([conflicted, pr(2, { statusCheckRollup: [{ state: 'PENDING' }] })])).toBeNull()
  expect(plan([conflicted, pr(2, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })])).toBeNull()
  expect(plan([conflicted])?.kind).toBe('resolve')
})

test('order: fork branches and repeated failures go back to you', () => {
  const fork = pr(1, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', isCrossRepository: true })
  expect(plan([fork])?.kind).toBe('needs-you')
  const stuck = pr(2, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
  expect(plan([stuck], {}, { 2: 2 })?.kind).toBe('needs-you')
})

test('the resolution prompt merges in a worktree, never force-pushes, and names the files to avoid', () => {
  const text = resolvePrompt(pr(4, { headRefName: 'feat/x' }), 'acme/widgets', [{ number: 7, files: ['src/shared.ts'] }])
  expect(text).toMatch(/git worktree add/)
  expect(text).toMatch(/git merge origin\/main/)
  expect(text).toMatch(/Never force-push/)
  expect(text).toMatch(/git push origin HEAD:feat\/x/)
  expect(text).toMatch(/#7: src\/shared\.ts/)
})

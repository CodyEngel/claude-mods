import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 140 },
} as const

test('the band draws a Keep warm toggle that flips on each press', async ($, on) => {
  mock.clock(on)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 76_000, window: 200_000, percent: 38 },
      rateLimits: [],
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cache-meter', surface, ...BAND } as never)
    expect(await ui.find({ key: 'compact' })).toBeDefined()
    const before = (await ui.find({ key: 'keep-warm' }))?.text
    expect(before).toMatch(/Keep warm/)
    await ui.press({ key: 'keep-warm' })
    const after = (await ui.find({ key: 'keep-warm' }))?.text
    expect(after).not.toBe(before)
    await ui.unmount()
  }
})

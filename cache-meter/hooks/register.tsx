import type { Hook, Register } from 'claude-code'

type CacheMark = {
  /** When the last main-thread API request finished, ms since the epoch. */
  at: number
  /** Tokens that request read from the prompt cache. */
  read: number
  /** Tokens that request wrote to the prompt cache. */
  written: number
}

// Kept in the module rather than $.state, which some engine versions don't provide.
let mark: CacheMark | null = null
let isHidden = false
let isCompacting = false

// Keep warm: ping the cache just before it expires while the session is idle.
let keepWarm = false
let isPinging = false
let isTurnRunning = false
let lastActivity = 0
let pings = 0

const PING_PROMPT = 'Keep-alive ping from the cache-meter plugin. Reply with only: ok'

type Api = Parameters<Hook<'session.start'>>[0]

const MINUTE = 60_000

const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')

  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const clamp = (fraction: number) => Math.min(1, Math.max(0, fraction))

// Green under a third used, yellow under two thirds, red past that.
const level = (fraction: number) => (fraction < 1 / 3 ? 'green' : fraction < 2 / 3 ? 'yellow' : 'red')

const HEX = { green: '#22c55e', yellow: '#eab308', red: '#ef4444' } as const

const LINE_PX = { width: 96, height: 4 } as const

const lineSvg = (fraction: number) => {
  const { width, height } = LINE_PX
  const filled = Math.round(clamp(fraction) * width)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="2" fill="#8884" />` +
    `<rect width="${filled}" height="${height}" rx="2" fill="${HEX[level(fraction)]}" />` +
    `</svg>`
  )
}

let hasWarned = false
let hasExpired = false

function remember($: Api, value: CacheMark | null) {
  hasWarned = false
  hasExpired = false
  mark = value
  $.ui.invalidate('ui.render')
}

function stopKeepWarm($: Api, why: string) {
  keepWarm = false
  $.ui.toast(`Keep warm stopped: ${why}`)
  $.ui.invalidate('ui.render')
}

// Resends the main thread's last request plus a one-line prompt, so the prefix is read
// from the cache and its TTL restarts. Stops itself if the cache didn't actually serve it.
async function ping($: Api) {
  isPinging = true
  $.ui.invalidate('ui.render')
  try {
    // The cache lifetime counts from the start of the request that reads it.
    const startedAt = await $.clock.now()
    const reply = await $.model.fork({ prompt: PING_PROMPT })

    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      return
    }
    if (!reply.isAnswered && reply.reason !== 'empty-reply') {
      stopKeepWarm($, `the ping failed (${reply.reason})`)
      return
    }

    const usage = reply.usage
    const read = usage.cache_read_input_tokens
    const written = usage.cache_creation_input_tokens
    const sent = read + written + usage.input_tokens
    remember($, { at: startedAt, read, written })

    if (sent > 0 && read / sent < 0.5) {
      stopKeepWarm($, 'the cache had already lapsed, so the ping re-cached it instead of keeping it warm')
      return
    }
    pings += 1
  } catch {
    stopKeepWarm($, 'the ping could not be sent')
  } finally {
    isPinging = false
    $.ui.invalidate('ui.render')
  }
}

export const register: Register = (on, options) => {
  const ttlMs = options.cacheTtl === '5m' ? 5 * MINUTE : 60 * MINUTE
  const warnMs = Math.max(0, Number(options.warnMinutes ?? 5)) * MINUTE
  const cutoffMs = Math.max(0, Number(options.keepWarmCutoffHours ?? 8)) * 60 * MINUTE
  // Ping this long before expiry: 5 minutes on the 1h TTL, 1 minute on the 5m TTL.
  const leadMs = Math.min(5 * MINUTE, ttlMs / 5)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache-meter',
      description: 'Show or hide the prompt-cache and context band',
    })
    lastActivity = await $.clock.now()

    $.clock.every(1000, async () => {
      $.ui.invalidate('ui.render')

      const last = mark
      if (last === null) return
      const at = await $.clock.now()
      const left = last.at + ttlMs - at

      if (keepWarm && at - lastActivity >= cutoffMs) {
        stopKeepWarm($, `idle for ${Math.round(cutoffMs / (60 * MINUTE))}h`)
      }

      if (keepWarm && left > 0 && left <= leadMs && !isPinging && !isTurnRunning && !isCompacting) {
        void ping($)
        return
      }

      if (left <= 0 && !hasExpired) {
        hasExpired = true
        $.ui.toast('Prompt cache expired: the next message re-caches the whole context')
      } else if (!keepWarm && left > 0 && left <= warnMs && !hasWarned) {
        hasWarned = true
        $.ui.toast(`Prompt cache expires in ${clock(left)}`)
      }
    })

    return next(e)
  })

  // A resumed session: the cache clock started at its last response, not now.
  on('classic.SessionStart', async ($, e, next) => {
    const seconds = e.seconds_since_last_response
    if (typeof seconds === 'number') {
      const at = (await $.clock.now()) - seconds * 1000
      remember($, { at, read: 0, written: 0 })
    }

    return next(e)
  })

  on('command.run', { command: 'cache-meter' }, async $ => {
    isHidden = !isHidden
    $.ui.invalidate('ui.render')
    const hidden = isHidden

    return { text: hidden ? 'Cache meter hidden.' : 'Cache meter shown.' }
  })

  // A turn of yours counts as activity for the keep-warm idle cutoff, and blocks pings.
  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    lastActivity = await $.clock.now()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      lastActivity = await $.clock.now()
    }

    return next(e)
  })

  // Every main-thread request re-reads and refreshes the cache, so the TTL restarts there.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)

    if (e.agentId === undefined && result.usage) {
      remember($, {
        at: await $.clock.now(),
        read: result.usage.cache_read_input_tokens,
        written: result.usage.cache_creation_input_tokens,
      })
    }

    return result
  })

  // After a compaction the old prefix is gone; the next request writes a new one.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (e.trigger !== 'precompute' && e.agentId === undefined && result.skip === undefined) {
      remember($, null)
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || isHidden) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const last = mark
    const at = await $.clock.now()
    const compacting = isCompacting
    const { context } = await $.session.usage()
    const narrow = e.props.bodyColumns < 90
    const cells = narrow ? 6 : 10

    // A 4px line where the surface draws pixels; the thinnest box-drawing line on a terminal.
    const line = (fraction: number, alt: string) => {
      if ('Svg' in elements) {
        const { Svg } = elements
        return <Svg source={lineSvg(fraction)} alt={alt} width={LINE_PX.width} height={LINE_PX.height} />
      }
      const filled = Math.round(clamp(fraction) * cells)
      return (
        <Text>
          <Text color={level(fraction)}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(cells - filled)}</Text>
        </Text>
      )
    }

    let cache = <Text dimColor>Cache: cold, nothing sent yet</Text>
    if (e.props.isWorking) {
      cache = <Text color="cyan">Cache: refreshing…</Text>
    } else if (last !== null) {
      const left = last.at + ttlMs - at
      const elapsed = 1 - left / ttlMs
      const hit = last.read + last.written > 0 ? Math.round((last.read / (last.read + last.written)) * 100) : null

      cache =
        left <= 0 ? (
          <Text color="red">Cache: expired {clock(-left)} ago</Text>
        ) : (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text>Cache {clock(left)}</Text>
            {line(elapsed, `${Math.round(elapsed * 100)}% of the cache window used`)}
            {!narrow && hit !== null && <Text dimColor>{hit}% hit</Text>}
            {isPinging ? (
              <Text color="cyan">pinging…</Text>
            ) : (
              keepWarm && !narrow && <Text dimColor>ping in {clock(left - leadMs)}</Text>
            )}
          </Box>
        )
    }

    const percent = context.percent ?? 0
    const used = context.tokens ?? 0

    const onKeepWarm = async () => {
      keepWarm = !keepWarm
      lastActivity = await $.clock.now()
      $.ui.toast(
        keepWarm
          ? `Keep warm on: pings ${clock(leadMs)} before expiry while idle, stops after ${Math.round(cutoffMs / (60 * MINUTE))}h idle`
          : 'Keep warm off',
      )
      $.ui.invalidate('ui.render')
    }

    const onCompact = async () => {
      isCompacting = true
      $.ui.invalidate('ui.render')
      try {
        const done = await $.session.compact()
        $.ui.toast(done.skip === undefined ? 'Compacted' : `Compact skipped: ${done.skip}`)
      } catch {
        $.ui.toast('Can’t compact while a turn is running')
      } finally {
        isCompacting = false
        $.ui.invalidate('ui.render')
      }
    }

    return (
      <Box flexDirection="row" alignItems="center" gap={2}>
        {cache}
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text>Context {percent}%</Text>
          {line(percent / 100, `${percent}% of the context window used`)}
          {!narrow && (
            <Text dimColor>
              {tokens(used)}/{tokens(context.window)}
            </Text>
          )}
        </Box>
        <Button
          key="keep-warm"
          label={keepWarm ? `Keep warm ✓${pings > 0 ? ` ×${pings}` : ''}` : 'Keep warm'}
          hotkey="k"
          variant={keepWarm ? 'primary' : undefined}
          dimColor={!keepWarm}
          onPress={onKeepWarm}
        />
        {compacting ? (
          <Text color="cyan">Compacting…</Text>
        ) : (
          !e.props.isWorking && (
            <Button key="compact" label="Compact" hotkey="c" onPress={onCompact} />
          )
        )}
      </Box>
    )
  })
}

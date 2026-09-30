import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The header banner reads vitals through cachedVitals. It used to be Next's
 * unstable_cache, which serves a stale entry and refreshes it after the
 * response — on App Runner, whose instances get no CPU between requests, the
 * refresh did not land and the banner kept an alarm the database had cleared
 * (CROFT-303). The cache now refreshes before answering once it is stale.
 */
let calls = 0
let recent = 0
let failNext = false

vi.mock('@/lib/db/client', () => ({
  admin: () => ({
    rpc: async (name: string) => {
      if (name === 'croft_vitals') {
        calls += 1
        if (failNext) {
          failNext = false
          return { data: null, error: { message: 'down' } }
        }
        return { data: { windowHours: 24, sessions: { recent, baseline: 7 } }, error: null }
      }
      return { data: null, error: { message: 'not stubbed' } }
    },
  }),
}))

beforeEach(() => {
  calls = 0
  recent = 0
  vi.useFakeTimers()
  vi.resetModules()
})
afterEach(() => vi.useRealTimers())

describe('cachedVitals', () => {
  it('answers from the cache within a minute', async () => {
    const { cachedVitals } = await import('./vitals')
    await cachedVitals('u1')
    await cachedVitals('u1')
    expect(calls).toBe(1)
  })

  it('reads the database again once the entry is a minute old, and returns that answer', async () => {
    const { cachedVitals } = await import('./vitals')
    expect((await cachedVitals('u1')).sessions.recent).toBe(0)
    recent = 1
    vi.advanceTimersByTime(61_000)
    // The fresh value, on this request — not the stale one while a refresh runs.
    expect((await cachedVitals('u1')).sessions.recent).toBe(1)
    expect(calls).toBe(2)
  })

  it('does not remember a failed read', async () => {
    const { cachedVitals } = await import('./vitals')
    failNext = true
    await expect(cachedVitals('u1')).rejects.toThrow('down')
    expect((await cachedVitals('u1')).sessions.recent).toBe(0)
    expect(calls).toBe(2)
  })

  it('keeps each user apart', async () => {
    const { cachedVitals } = await import('./vitals')
    await cachedVitals('u1')
    await cachedVitals('u2')
    expect(calls).toBe(2)
  })
})

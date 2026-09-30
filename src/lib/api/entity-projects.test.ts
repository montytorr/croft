import { describe, expect, it } from 'vitest'
import { withFakePool } from '@/lib/db/fake-pool'
import { resolveProjectKeys } from './entity-projects'

describe('resolveProjectKeys', () => {
  /**
   * CROFT-239: the patch path used whatever the lookup returned, so a key
   * matching no project quietly vanished and `--project NOSUCH` reported
   * success with `added: 0`.
   */
  it('names the keys that match no project', async () => {
    const { result } = await withFakePool(() => resolveProjectKeys(['croft', 'nosuch']), [
      { id: 'id-croft', key: 'CROFT' },
    ])

    expect(result.missing).toEqual(['NOSUCH'])
    expect(result.ids).toEqual(['id-croft'])
    expect(result.error).toBeNull()
  })

  it('upper-cases what it was given, and reports the missing key that way', async () => {
    const { result } = await withFakePool(() => resolveProjectKeys(['nosuch']), [])

    expect(result.missing).toEqual(['NOSUCH'])
    expect(result.ids).toEqual([])
  })

  it('resolves every key when they all exist', async () => {
    const { result } = await withFakePool(() => resolveProjectKeys(['croft', 'trig']), [
      { id: 'id-trig', key: 'TRIG' },
      { id: 'id-croft', key: 'CROFT' },
    ])

    expect(result.missing).toEqual([])
    // Ordered by what the caller asked for, not by what Postgres happened to
    // return, so `added: n` lines up with the request.
    expect(result.ids).toEqual(['id-croft', 'id-trig'])
  })

  it('de-duplicates a key repeated in one request', async () => {
    const { result, parameters } = await withFakePool(
      () => resolveProjectKeys(['croft', 'CROFT']),
      [{ id: 'id-croft', key: 'CROFT' }],
    )

    expect(result.ids).toEqual(['id-croft'])
    // One bound parameter, not two: the repeat never reached Postgres.
    expect(parameters[0]).toEqual(['CROFT'])
  })

  it('surfaces a query failure instead of reading it as "no such project"', async () => {
    // Dropping the error made a database outage look exactly like a typo.
    const scope = globalThis as typeof globalThis & { __croftPool?: unknown }
    const prior = scope.__croftPool
    scope.__croftPool = {
      connect: async () => ({
        query: async () => {
          throw Object.assign(new Error('connection terminated'), { code: '08006' })
        },
        release: () => {},
      }),
    }

    try {
      const result = await resolveProjectKeys(['croft'])
      expect(result.error).toBe('connection terminated')
      expect(result.missing).toEqual([])
      expect(result.ids).toEqual([])
    } finally {
      scope.__croftPool = prior
    }
  })

  it('asks nothing of the database for an empty list', async () => {
    const { result, statements } = await withFakePool(() => resolveProjectKeys([]))

    expect(statements).toEqual([])
    expect(result).toEqual({ ids: [], missing: [], error: null })
  })
})

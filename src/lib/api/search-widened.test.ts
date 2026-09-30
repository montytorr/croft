import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What `widened` means after migration 055.
 *
 * It used to mean "the precise arm came back thin, so we fell back", and it was
 * read off the rows as "any row is loose". Both arms now always run, so almost
 * every result set contains a loose row and that reading would be true almost
 * always — turning the Vitals widening rate ("a search that widened is one the
 * precise question could not answer") into a constant, and the CLI's "treat
 * this subject as new" warning into a line printed over correct answers.
 *
 * The question the flag exists to answer is still a real one, so it is asked of
 * the thing that still answers it: did ANYTHING clear the precise arm.
 */

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('@/lib/db/client', () => ({
  admin: () => ({ rpc: mocks.rpc }),
}))

import { searchAll } from './search'

const row = (ref: string, widened: boolean) => ({
  kind: 'task' as const,
  id: `id-${ref}`,
  ref,
  title: ref,
  subtitle: null,
  project_key: 'CROFT',
  status: 'done',
  type: 'bug',
  answered: true,
  updated_at: '2026-09-21T00:00:00.000Z',
  body_bytes: 10,
  rank: 0.1,
  widened,
})

const returning = (rows: ReturnType<typeof row>[]) => {
  mocks.rpc.mockResolvedValue({ data: rows, error: null })
}

// Prose, so neither the ref nor the bare-number path touches the database.
const QUERY = 'agents finish work without ever claiming the task'

describe('what a widened search means now that both arms always run', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
  })

  it('is not widened when something cleared the precise arm', async () => {
    // The case the old derivation got wrong. The precise head is exactly what
    // 055 added, and under "any row is loose" this search — one good hit and
    // nineteen loose ones — would have been reported as a search that found
    // nothing precise.
    returning([row('CROFT-135', false), row('CROFT-9', true), row('CROFT-12', true)])

    const { widened } = await searchAll('user-1', QUERY, {}, 20)

    expect(widened).toBe(false)
  })

  it('is widened when every row is a loose word overlap', async () => {
    returning([row('CROFT-9', true), row('CROFT-12', true)])

    const { widened } = await searchAll('user-1', QUERY, {}, 20)

    expect(widened).toBe(true)
  })

  it('is not widened when there was nothing to widen to', async () => {
    // Zero rows is `zeroResults`, which search_events has counted separately
    // since 024. Reporting it as widening would double-count the same failure
    // and inflate the rate the Vitals page reads.
    returning([])

    const { widened } = await searchAll('user-1', QUERY, {}, 20)

    expect(widened).toBe(false)
  })

  it('still says which individual rows were loose', async () => {
    // The per-row flag is the one the CLI prints as "N precise, M loose" and
    // the one the merge orders on. Only the query-level summary changed.
    returning([row('CROFT-135', false), row('CROFT-9', true)])

    const { rows } = await searchAll('user-1', QUERY, {}, 20)

    expect(rows.map((r) => r.widened)).toEqual([false, true])
  })

  it('passes the distinctive terms the threshold is counted over', async () => {
    returning([])

    await searchAll('user-1', QUERY, {}, 20)

    // The database counts how many of these a row carries and compares it
    // with half of them. Pre-joining them into one string, or not sending
    // them at all, leaves it nothing to count.
    expect(mocks.rpc).toHaveBeenCalledWith(
      'search_all',
      expect.objectContaining({
        p_terms: ['agents', 'finish', 'work', 'without', 'ever', 'claiming', 'task'],
      }),
    )
  })
})

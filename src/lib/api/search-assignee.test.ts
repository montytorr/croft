import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `croft check --assignee` (CROFT-310).
 *
 * `search_tasks` applies its limit inside the ranking, so narrowing its answer
 * afterwards would hand back two of someone's tasks out of twenty hits rather
 * than twenty of theirs. The narrowing asks for a larger pool, keeps the
 * database's order, and only then applies the caller's limit.
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  owned: [] as string[],
  filters: [] as [string, unknown][],
}))

vi.mock('@/lib/db/client', () => ({
  admin: () => ({
    rpc: mocks.rpc,
    from: () => {
      const query = {
        select: () => query,
        in: (column: string, value: unknown) => { mocks.filters.push([column, value]); return query },
        eq: (column: string, value: unknown) => { mocks.filters.push([column, value]); return query },
        then: (resolve: (result: { data: { id: string }[] }) => unknown) =>
          Promise.resolve(resolve({ data: mocks.owned.map((id) => ({ id })) })),
      }
      return query
    },
  }),
}))

import { searchTasks } from './search'

const row = (number: number, widened = false) => ({
  id: `id-${number}`,
  number,
  title: `task ${number}`,
  type: 'bug',
  status: 'todo',
  priority: 'medium',
  resolution: null,
  resolution_kind: null,
  description: null,
  claimed_by: null,
  updated_at: '2026-09-21T00:00:00.000Z',
  external_ref: null,
  project_key: 'CROFT',
  rank: 1,
  coverage: 1,
  widened,
})

// Prose, so neither the ref nor the bare-number path touches the database.
const QUERY = 'agents finish work without claiming'

describe('searchTasks narrowed to one assignee', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    mocks.owned = []
    mocks.filters = []
  })

  it('keeps only their tasks, in the order the database ranked them', async () => {
    mocks.rpc.mockResolvedValue({ data: [row(1), row(2, true), row(3), row(4, true)], error: null })
    mocks.owned = ['id-4', 'id-3']

    const { rows, widened } = await searchTasks('user-1', QUERY, { assignee: 'user-julien' }, 20)

    expect(rows.map((r) => r.number)).toEqual([3, 4])
    expect(widened).toBe(true)
    expect(mocks.filters).toContainEqual(['assignee_user_id', 'user-julien'])
  })

  it('ranks from a larger pool than it returns, then applies the limit', async () => {
    mocks.rpc.mockResolvedValue({ data: [row(1), row(2), row(3)], error: null })
    mocks.owned = ['id-1', 'id-2', 'id-3']

    const { rows } = await searchTasks('user-1', QUERY, { assignee: 'user-julien' }, 2)

    expect(mocks.rpc).toHaveBeenCalledWith('search_tasks', expect.objectContaining({ p_limit: 200 }))
    expect(rows.map((r) => r.number)).toEqual([1, 2])
  })

  it('reports widened only from what the caller is handed', async () => {
    // The loose row was someone else's. Reporting the search as widened would
    // print "N precise, M loose" over rows that are all precise.
    mocks.rpc.mockResolvedValue({ data: [row(1), row(2, true)], error: null })
    mocks.owned = ['id-1']

    const { rows, widened } = await searchTasks('user-1', QUERY, { assignee: 'user-julien' }, 20)

    expect(rows.map((r) => r.number)).toEqual([1])
    expect(widened).toBe(false)
  })

  it('asks for exactly the limit when no assignee is set', async () => {
    mocks.rpc.mockResolvedValue({ data: [row(1)], error: null })

    await searchTasks('user-1', QUERY, {}, 20)

    expect(mocks.rpc).toHaveBeenCalledWith('search_tasks', expect.objectContaining({ p_limit: 20 }))
    expect(mocks.filters).toEqual([])
  })
})

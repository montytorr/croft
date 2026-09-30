import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  searchAll: vi.fn(),
  searchTasks: vi.fn(),
  recordSearch: vi.fn(),
  resolveAssignee: vi.fn(),
}))

vi.mock('@/lib/api/people', () => ({ resolveAssignee: mocks.resolveAssignee }))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))

vi.mock('@/lib/api/search', () => ({
  searchAll: mocks.searchAll,
  searchTasks: mocks.searchTasks,
}))

vi.mock('@/lib/api/search-events', () => ({
  recordSearch: mocks.recordSearch,
  recordKnowledgeRead: vi.fn(),
}))

vi.mock('@/lib/api/staleness', () => ({ stalenessFor: vi.fn(async () => new Map()) }))

// markStaleKnowledge reaches the knowledge table directly; it is not what is
// under test here, so it returns nothing and the results stay unmarked.
vi.mock('@/lib/db/client', () => ({
  admin: () => ({
    from: () => ({ select: () => ({ in: async () => ({ data: [] }) }) }),
  }),
}))

import { GET } from './route'

const actor = {
  userId: 'user-1',
  actorType: 'agent',
  actorId: 'claude-code · cal@example.test',
  userDisplayName: 'Cal',
  role: 'admin',
  rateKey: `search-refs-${Math.random()}`,
  sessionId: null,
}

const search = (query: string) =>
  GET(
    new Request(`https://croft.example.test/api/v1/search?${query}`),
    { params: Promise.resolve({}) },
  )

/** The sixth argument to recordSearch: the refs that came back. */
const recordedRefs = () => mocks.recordSearch.mock.calls[0]?.[5] as string[]

const unifiedRow = (kind: string, ref: string) => ({
  kind,
  id: `id-${ref}`,
  ref,
  title: ref,
  subtitle: null,
  project_key: 'CROFT',
  status: null,
  type: null,
  answered: false,
  updated_at: '2026-09-21T00:00:00.000Z',
  body_bytes: 40,
  rank: 1,
  widened: false,
})

const taskRow = (number: number) => ({
  id: `id-${number}`,
  number,
  title: `task ${number}`,
  type: 'bug',
  status: 'open',
  priority: 'medium',
  resolution: null,
  resolution_kind: null,
  description: null,
  claimed_by: null,
  updated_at: '2026-09-21T00:00:00.000Z',
  external_ref: 'LEGACY-373',
  project_key: 'CROFT',
  rank: 1,
  coverage: 1,
  widened: false,
})

describe('search records which entries it returned', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor)
    mocks.searchAll.mockReset()
    mocks.searchTasks.mockReset()
    mocks.recordSearch.mockReset().mockResolvedValue(undefined)
  })

  it('stores the refs of a unified search, in rank order', async () => {
    mocks.searchAll.mockResolvedValue({
      rows: [
        unifiedRow('knowledge', 'supabase-connection-pooling'),
        unifiedRow('task', 'CROFT-131'),
        unifiedRow('note', 'CROFT-88#3'),
      ],
      widened: true,
    })

    const response = await search('q=supavisor+pool+timeouts')

    expect(response.status).toBe(200)
    expect(recordedRefs()).toEqual([
      'supabase-connection-pooling',
      'CROFT-131',
      'CROFT-88#3',
    ])
  })

  it('stores the refs on the task-only path too', async () => {
    mocks.searchTasks.mockResolvedValue({ rows: [taskRow(131), taskRow(88)], widened: false })

    await search('q=pool+timeouts&tasksOnly=true')

    // The Croft ref, never the imported identifier — a stored "LEGACY-373"
    // looks like a ref and resolves to nothing, so the event could not be
    // replayed against the corpus.
    expect(recordedRefs()).toEqual(['CROFT-131', 'CROFT-88'])
  })

  it('stores an empty list rather than nothing when the search found nothing', async () => {
    mocks.searchAll.mockResolvedValue({ rows: [], widened: true })

    await search('q=a+subject+croft+has+never+heard+of')

    expect(recordedRefs()).toEqual([])
  })

  it('records the same count it reports to the caller', async () => {
    mocks.searchAll.mockResolvedValue({
      rows: [unifiedRow('task', 'CROFT-1'), unifiedRow('task', 'CROFT-2')],
      widened: false,
    })

    const response = await search('q=anything')
    const payload = (await response.json()) as { data: { count: number; results: unknown[] } }

    expect(payload.data.count).toBe(2)
    expect(recordedRefs()).toHaveLength(payload.data.results.length)
  })
})

describe('search by assignee (CROFT-310)', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor)
    mocks.searchAll.mockReset()
    mocks.searchTasks.mockReset().mockResolvedValue({ rows: [taskRow(131)], widened: false })
    mocks.recordSearch.mockReset().mockResolvedValue(undefined)
    mocks.resolveAssignee.mockReset()
  })

  it('resolves the person and narrows to their tasks, which selects the task path', async () => {
    mocks.resolveAssignee.mockResolvedValue({
      ok: true,
      person: { id: 'user-julien', email: 'julien@example.test', name: 'Julien', active: true },
    })

    const response = await search('q=pool+timeouts&assignee=julien')

    expect(response.status).toBe(200)
    expect(mocks.resolveAssignee).toHaveBeenCalledWith('julien', 'user-1')
    // An assignee is a statement about tasks, like a type or a status: it is
    // not silently dropped by the unified path.
    expect(mocks.searchAll).not.toHaveBeenCalled()
    expect(mocks.searchTasks).toHaveBeenCalledWith(
      'user-1',
      'pool timeouts',
      expect.objectContaining({ assignee: 'user-julien' }),
      20,
    )
  })

  it('refuses a name that matches nobody rather than reporting the subject as new', async () => {
    mocks.resolveAssignee.mockResolvedValue({ ok: false, code: 'not_found', error: 'No user julian.' })

    const response = await search('q=pool+timeouts&assignee=julian')

    expect(response.status).toBe(404)
    expect(mocks.searchTasks).not.toHaveBeenCalled()
    expect(mocks.searchAll).not.toHaveBeenCalled()
  })
})

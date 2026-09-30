import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  searchAll: vi.fn(),
  searchTasks: vi.fn(),
  resolveAssignee: vi.fn(),
}))

vi.mock('@/lib/api/people', () => ({ resolveAssignee: mocks.resolveAssignee }))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))

vi.mock('@/lib/api/search', () => ({
  searchAll: mocks.searchAll,
  searchTasks: mocks.searchTasks,
}))

// attachConclusions reads subjects directly; it is not what is under test
// here, so it returns nothing.
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

describe('search by assignee (CROFT-310)', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor)
    mocks.searchAll.mockReset()
    mocks.searchTasks.mockReset().mockResolvedValue({ rows: [taskRow(131)], widened: false })
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

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  searchAll: vi.fn(),
}))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))

vi.mock('@/lib/api/search', () => ({ searchAll: mocks.searchAll }))

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
  rateKey: `search-${Math.random()}`,
  sessionId: null,
}

const search = (query: string) =>
  GET(
    new Request(`https://croft.example.test/api/v1/search?${query}`),
    { params: Promise.resolve({}) },
  )

describe('search', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor)
    mocks.searchAll.mockReset().mockResolvedValue({ rows: [], widened: false })
  })

  it('always searches the unified index, whatever task-only filters an older CLI still sends', async () => {
    const response = await search('q=pool+timeouts&tasksOnly=1&type=bug&status=done&assignee=julien&project=T')

    expect(response.status).toBe(200)
    expect(mocks.searchAll).toHaveBeenCalledWith('user-1', 'pool timeouts', { kinds: undefined }, 20)
  })

  it('narrows to the kinds asked for', async () => {
    await search('q=pool+timeouts&kinds=task,subject&limit=5')

    expect(mocks.searchAll).toHaveBeenCalledWith('user-1', 'pool timeouts', { kinds: ['task', 'subject'] }, 5)
  })

  it('asks for a query', async () => {
    const response = await search('limit=5')

    expect(response.status).toBe(400)
    expect(mocks.searchAll).not.toHaveBeenCalled()
  })
})

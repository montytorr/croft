import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  updateKnowledge: vi.fn(),
  knownSlugs: vi.fn(),
}))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))

vi.mock('@/lib/api/knowledge', () => ({
  getKnowledge: vi.fn(),
  updateKnowledge: mocks.updateKnowledge,
  deleteKnowledge: vi.fn(),
}))

vi.mock('@/lib/api/search-events', () => ({
  recordKnowledgeRead: vi.fn(),
  recordSearch: vi.fn(),
}))

vi.mock('@/lib/api/activity', () => ({ recordActivity: vi.fn() }))

// Keep the real resolver — it is what is under test — and stub only the store.
vi.mock('@/lib/api/knowledge-graph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/knowledge-graph')>()),
  knownSlugs: mocks.knownSlugs,
}))

import { PATCH } from './route'

const actor = {
  userId: 'user-1',
  actorType: 'agent',
  actorId: 'claude-code · cal@example.test',
  userDisplayName: 'Cal',
  role: 'admin',
  rateKey: `knowledge-patch-${Math.random()}`,
  sessionId: null,
}

const patch = (slug: string, body: unknown) =>
  PATCH(
    new Request(`https://croft.example.test/api/v1/knowledge/${slug}`, {
      method: 'PATCH',
      // Bearer, so the browser-origin guard takes its short-circuit branch.
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authenticate.mockResolvedValue({ ok: true, actor })
  mocks.updateKnowledge.mockResolvedValue({ slug: 'a-fact', title: 'A fact' })
  // The store holds the prefixed spelling; an edit guessing the bare one is
  // the exact 63% case.
  mocks.knownSlugs.mockResolvedValue(['project-borrower-insurance-appointments', 'a-fact'])
})

/**
 * POST resolved references and PATCH did not, which left the whole check
 * reachable in one hop: write a clean entry, then edit a dangling reference
 * into it with nothing looking.
 */
describe('PATCH /api/v1/knowledge/[slug]', () => {
  it('refuses an edit that introduces a reference the store already holds elsewhere', async () => {
    const res = await patch('a-fact', { body: 'see [[borrower-insurance-appointments]]' })
    expect(res.status).toBe(400)
    const payload = await res.json()
    expect(payload.success).toBe(false)
    expect(JSON.stringify(payload)).toContain('project-borrower-insurance-appointments')
    expect(mocks.updateKnowledge).not.toHaveBeenCalled()
  })

  it('lets the edit through when the caller insists', async () => {
    const res = await patch('a-fact', {
      body: 'see [[borrower-insurance-appointments]]',
      allowUnresolvedRefs: true,
    })
    expect(res.status).toBe(200)
    expect(mocks.updateKnowledge).toHaveBeenCalled()
  })

  it('does not re-check a body it is not changing', async () => {
    const res = await patch('a-fact', { verified: true })
    expect(res.status).toBe(200)
    expect(mocks.updateKnowledge).toHaveBeenCalled()
  })
})

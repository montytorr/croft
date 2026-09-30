import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), query: vi.fn() }))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/db/client', () => ({ pool: () => ({ query: mocks.query }) }))

import { GET } from './route'

const ORIGIN = 'https://croft.example.test'
const get = () => GET(new Request(`${ORIGIN}/api/v1/me/keys`), { params: Promise.resolve({}) })

const actor = (over: object = {}) => ({
  userId: 'user-1', actorId: 'cal@example.test', role: 'member', actorType: 'human',
  userDisplayName: 'Cal', rateKey: `me-keys-${Math.random()}`, sessionId: null, ...over,
})

describe('GET /api/v1/me/keys', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor())
    mocks.query.mockReset().mockResolvedValue({
      rows: [
        {
          id: 'key-1',
          agent_name: 'claude-code',
          name: 'claude-code on laptop',
          key_prefix: 'sk_live_',
          // Never selected — but if it ever were, it must still not leave.
          key_hash: 'deadbeef',
          created_at: new Date('2026-09-01T10:00:00Z'),
          last_used_at: null,
          revoked_at: null,
          key_auth_epoch: '0',
          user_auth_epoch: '0',
        },
      ],
    })
  })

  it('lists only the caller\'s keys, camelCased, with no hash', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toEqual([
      {
        id: 'key-1',
        agentName: 'claude-code',
        name: 'claude-code on laptop',
        keyPrefix: 'sk_live_',
        createdAt: '2026-09-01T10:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null,
        revoked: false,
      },
    ])
    expect(JSON.stringify(body)).not.toContain('deadbeef')
    const [sql, values] = mocks.query.mock.calls[0]!
    expect(sql).toMatch(/where k\.user_id = \$1/)
    expect(sql).not.toMatch(/key_hash/)
    expect(values).toEqual(['user-1'])
  })

  it('reports a key as revoked when its auth_epoch has fallen behind its user\'s, even with revoked_at still null', async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: 'key-1',
          agent_name: 'claude-code',
          name: 'claude-code on laptop',
          key_prefix: 'sk_live_',
          created_at: new Date('2026-09-01T10:00:00Z'),
          last_used_at: null,
          revoked_at: null,
          key_auth_epoch: '0',
          user_auth_epoch: '1',
        },
      ],
    })
    const response = await get()
    const body = await response.json()
    expect(body.data[0]).toMatchObject({ revokedAt: null, revoked: true })
  })

  it('works for a member, not just an administrator', async () => {
    mocks.authenticate.mockResolvedValue(actor({ role: 'member' }))
    expect((await get()).status).toBe(200)
  })

  it('refuses an agent key, even an administrator\'s', async () => {
    mocks.authenticate.mockResolvedValue(actor({ actorType: 'agent', role: 'admin' }))
    const response = await get()
    expect(response.status).toBe(403)
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('refuses a caller who is not signed in', async () => {
    mocks.authenticate.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), revokeUserKey: vi.fn() }))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/api/users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/users')>()
  return { ...actual, revokeUserKey: mocks.revokeUserKey }
})

import { UserAdminError } from '@/lib/api/users'
import { DELETE } from './route'

const ORIGIN = 'https://croft.example.test'
const KEY_ID = '11111111-2222-4333-8444-555555555555'

const del = (keyId = KEY_ID, origin = ORIGIN) =>
  DELETE(
    new Request(`${ORIGIN}/api/v1/me/keys/${keyId}`, { method: 'DELETE', headers: { origin } }),
    { params: Promise.resolve({ keyId }) },
  )

const actor = (over: object = {}) => ({
  userId: 'user-1', actorId: 'cal@example.test', role: 'member', actorType: 'human',
  userDisplayName: 'Cal', rateKey: `me-key-${Math.random()}`, sessionId: null, ...over,
})

describe('DELETE /api/v1/me/keys/{keyId}', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor())
    mocks.revokeUserKey.mockReset().mockResolvedValue({
      id: KEY_ID,
      agentName: 'codex',
      revokedAt: '2026-09-29T12:00:00.000Z',
    })
  })

  it('revokes one of the caller\'s own keys through the administrator\'s revocation', async () => {
    const response = await del()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      data: { id: KEY_ID, agentName: 'codex', revokedAt: '2026-09-29T12:00:00.000Z' },
    })
    // Scoped to the caller: the owner is never taken from the request.
    expect(mocks.revokeUserKey).toHaveBeenCalledWith('user-1', KEY_ID)
  })

  it('answers 404 for a key that is someone else\'s, exactly as for one that never existed', async () => {
    mocks.revokeUserKey.mockRejectedValue(new UserAdminError('not_found', 'No such active key.'))
    const response = await del()
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toMatchObject({ success: false, error: 'No such active key.' })
  })

  it('refuses an agent key, even an administrator\'s', async () => {
    mocks.authenticate.mockResolvedValue(actor({ actorType: 'agent', role: 'admin' }))
    const response = await DELETE(
      new Request(`${ORIGIN}/api/v1/me/keys/${KEY_ID}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer sk_live_whatever' },
      }),
      { params: Promise.resolve({ keyId: KEY_ID }) },
    )
    expect(response.status).toBe(403)
    expect(mocks.revokeUserKey).not.toHaveBeenCalled()
  })

  it('rejects a browser mutation from another origin', async () => {
    const response = await del(KEY_ID, 'https://evil.example.test')
    expect(response.status).toBe(403)
    expect(mocks.revokeUserKey).not.toHaveBeenCalled()
  })
})

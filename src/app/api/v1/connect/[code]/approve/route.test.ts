import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  approveConnectRequest: vi.fn(),
}))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/api/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/connect')>()
  return { ...actual, approveConnectRequest: mocks.approveConnectRequest }
})

import { ConnectError } from '@/lib/api/connect'
import { POST } from './route'

const ORIGIN = 'https://croft.example.test'
const post = (body: object) =>
  POST(
    new Request(`${ORIGIN}/api/v1/connect/BCDF-2345/approve`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ code: 'BCDF-2345' }) },
  )

const actor = (over: object = {}) => ({
  userId: 'user-1', actorId: 'cal@example.test', role: 'member', actorType: 'human',
  userDisplayName: 'Cal', rateKey: `connect-${Math.random()}`, sessionId: null, ...over,
})

describe('POST /api/v1/connect/{code}/approve', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor())
    mocks.approveConnectRequest.mockReset().mockResolvedValue(undefined)
  })

  it('approves for the signed-in human, minting nothing itself', async () => {
    const response = await post({ runtimes: ['claude-code'] })
    expect(response.status).toBe(200)
    expect(mocks.approveConnectRequest).toHaveBeenCalledWith('BCDF-2345', {
      runtimes: ['claude-code'],
      approvedBy: 'user-1',
      approverRole: 'member',
    })
  })

  it('refuses an agent key, even an administrator\'s', async () => {
    mocks.authenticate.mockResolvedValue(actor({ actorType: 'agent', role: 'admin' }))
    const response = await post({ runtimes: ['claude-code'] })
    expect(response.status).toBe(403)
    expect(mocks.approveConnectRequest).not.toHaveBeenCalled()
  })

  it('refuses an empty runtime list before it ever reaches the lib', async () => {
    const response = await post({ runtimes: [] })
    expect(response.status).toBe(400)
    expect(mocks.approveConnectRequest).not.toHaveBeenCalled()
  })

  it('rejects a browser mutation from another origin', async () => {
    const response = await POST(
      new Request(`${ORIGIN}/api/v1/connect/BCDF-2345/approve`, {
        method: 'POST',
        headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' },
        body: JSON.stringify({ runtimes: ['claude-code'] }),
      }),
      { params: Promise.resolve({ code: 'BCDF-2345' }) },
    )
    expect(response.status).toBe(403)
    expect(mocks.approveConnectRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['not_found', 404],
    ['invalid_runtimes', 400],
    ['not_pending', 409],
  ] as const)('maps ConnectError(%s) to %i', async (code, status) => {
    mocks.approveConnectRequest.mockRejectedValue(new ConnectError(code, 'nope'))
    const response = await post({ runtimes: ['claude-code'] })
    expect(response.status).toBe(status)
  })
})

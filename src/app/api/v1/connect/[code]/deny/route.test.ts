import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  denyConnectRequest: vi.fn(),
}))

vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/api/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/connect')>()
  return { ...actual, denyConnectRequest: mocks.denyConnectRequest }
})

import { ConnectError } from '@/lib/api/connect'
import { POST } from './route'

const ORIGIN = 'https://croft.example.test'
const post = () =>
  POST(
    new Request(`${ORIGIN}/api/v1/connect/BCDF-2345/deny`, { method: 'POST', headers: { origin: ORIGIN } }),
    { params: Promise.resolve({ code: 'BCDF-2345' }) },
  )

const actor = (over: object = {}) => ({
  userId: 'user-1', actorId: 'cal@example.test', role: 'member', actorType: 'human',
  userDisplayName: 'Cal', rateKey: `connect-deny-${Math.random()}`, sessionId: null, ...over,
})

describe('POST /api/v1/connect/{code}/deny', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor())
    mocks.denyConnectRequest.mockReset().mockResolvedValue(undefined)
  })

  it('denies for the signed-in human', async () => {
    const response = await post()
    expect(response.status).toBe(200)
    expect(mocks.denyConnectRequest).toHaveBeenCalledWith('BCDF-2345')
  })

  it('refuses an agent key', async () => {
    mocks.authenticate.mockResolvedValue(actor({ actorType: 'agent' }))
    const response = await post()
    expect(response.status).toBe(403)
    expect(mocks.denyConnectRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['not_found', 404],
    ['not_pending', 409],
  ] as const)('maps ConnectError(%s) to %i', async (code, status) => {
    mocks.denyConnectRequest.mockRejectedValue(new ConnectError(code, 'nope'))
    const response = await post()
    expect(response.status).toBe(status)
  })
})

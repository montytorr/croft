import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pollConnectRequest: vi.fn() }))

vi.mock('@/lib/api/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/connect')>()
  return { ...actual, pollConnectRequest: mocks.pollConnectRequest }
})

import { POST } from './route'

const post = (body: object) =>
  POST(
    new Request('https://croft.example.test/api/v1/connect/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

describe('POST /api/v1/connect/poll', () => {
  beforeEach(() => {
    mocks.pollConnectRequest.mockReset()
  })

  it('needs no authentication, and always answers 200 with success:true for a valid body', async () => {
    mocks.pollConnectRequest.mockResolvedValue({ status: 'pending' })
    const response = await post({ deviceCode: 'A'.repeat(43) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ success: true, data: { status: 'pending' } })
  })

  it('passes through an approved answer with its keys', async () => {
    mocks.pollConnectRequest.mockResolvedValue({
      status: 'approved',
      user: { id: 'user-1', email: 'cal@example.test', name: 'Cal' },
      keys: [{ agentName: 'claude-code', key: 'sk_live_x' }],
    })
    const response = await post({ deviceCode: 'A'.repeat(43) })
    const body = await response.json()
    expect(body.data.keys).toEqual([{ agentName: 'claude-code', key: 'sk_live_x' }])
  })

  it('rejects a missing deviceCode before calling the lib', async () => {
    const response = await post({})
    expect(response.status).toBe(400)
    expect(mocks.pollConnectRequest).not.toHaveBeenCalled()
  })
})

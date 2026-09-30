import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createConnectRequest: vi.fn() }))

vi.mock('@/lib/api/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/connect')>()
  return { ...actual, createConnectRequest: mocks.createConnectRequest }
})

import { POST } from './route'

const post = (body: object, address = '203.0.113.1') =>
  POST(
    new Request('https://croft.example.test/api/v1/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
      body: JSON.stringify(body),
    }),
  )

describe('POST /api/v1/connect', () => {
  beforeEach(() => {
    mocks.createConnectRequest.mockReset().mockResolvedValue({
      deviceCode: 'device-secret', userCode: 'BCDF-2345',
      verificationUrl: 'https://croft.example.test/connect/BCDF-2345', expiresIn: 600, interval: 3,
    })
  })

  it('needs no authentication at all', async () => {
    const response = await post({ host: 'macbook', runtimes: ['claude-code'] }, '198.51.100.1')
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body).toMatchObject({ success: true, data: { userCode: 'BCDF-2345', expiresIn: 600, interval: 3 } })
  })

  it('rejects a runtime name shaped wrong', async () => {
    const response = await post({ host: 'macbook', runtimes: ['Not-Ok'] }, '198.51.100.2')
    expect(response.status).toBe(400)
    expect(mocks.createConnectRequest).not.toHaveBeenCalled()
  })

  it('rejects more than six runtimes', async () => {
    const runtimes = Array.from({ length: 7 }, (_, i) => `runtime-${i}`)
    const response = await post({ host: 'macbook', runtimes }, '198.51.100.3')
    expect(response.status).toBe(400)
  })

  it('rate-limits repeated requests from one address', async () => {
    const address = '198.51.100.4'
    for (let i = 0; i < 10; i += 1) {
      const response = await post({ host: 'macbook', runtimes: ['claude-code'] }, address)
      expect(response.status).toBe(201)
    }
    const eleventh = await post({ host: 'macbook', runtimes: ['claude-code'] }, address)
    expect(eleventh.status).toBe(429)
  })

  it('does not rate-limit a different address', async () => {
    const response = await post({ host: 'macbook', runtimes: ['claude-code'] }, '198.51.100.5')
    expect(response.status).toBe(201)
  })
})

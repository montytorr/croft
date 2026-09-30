import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), upsert: vi.fn() }))
vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/api/sessions', () => ({
  upsertSession: mocks.upsert,
  listSessions: vi.fn(),
}))
import { POST } from './route'

const post = (body: object) => POST(new Request('https://croft.example.test/api/v1/sessions', {
  method: 'POST', headers: { authorization: 'Bearer test', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}), { params: Promise.resolve({}) })

describe('session POST ongoing contract', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue({
      userId: 'user', actorId: 'agent', role: 'member', rateKey: `checkpoint-${Math.random()}`,
      actorType: 'agent', userDisplayName: 'Agent', sessionId: null,
    })
    mocks.upsert.mockReset().mockResolvedValue({ session: { id: 'one', ended_at: null }, checkpointed: [] })
  })

  it('accepts an ongoing checkpoint without implicitly checkpointing held tasks', async () => {
    const response = await post({ externalId: 'agent:example', platformSource: 'other', ongoing: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { id: 'one', endedAt: null, checkpointed: [] } })
    expect(mocks.upsert.mock.calls[0]?.[1]).toMatchObject({ ongoing: true, checkpointHeld: false })
  })

  it('rejects an ongoing write with endedAt or forced checkpointing', async () => {
    const response = await post({ externalId: 'agent:example', ongoing: true, checkpointHeld: true })
    expect(response.status).toBe(400)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('responds with a conflict when a late checkpoint tries to reopen a closed session', async () => {
    mocks.upsert.mockRejectedValueOnce(Object.assign(new Error('Session already ended; cannot checkpoint.'), { code: 'PZ001' }))
    const response = await post({ externalId: 'agent:example', ongoing: true })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'session_closed' })
  })

  it('still defaults an omitted ongoing flag to the end path', async () => {
    await post({ externalId: 'agent:example' })
    expect(mocks.upsert.mock.calls[0]?.[1]).toMatchObject({ ongoing: false, checkpointHeld: true })
  })
})

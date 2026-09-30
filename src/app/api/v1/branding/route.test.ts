import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  upsert: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock('@/lib/api/auth', () => ({ authenticate: mocks.authenticate }))
vi.mock('@/lib/db/client', () => ({
  admin: () => ({ from: () => ({ upsert: mocks.upsert }) }),
}))
vi.mock('@/lib/branding', () => ({
  DEFAULT_NAME: 'Croft',
  getBranding: async () => ({ name: 'Dispofi Croft', accent: '#01519b', version: '1', palette: null }),
  invalidateBranding: mocks.invalidate,
}))
import { PUT } from './route'

const ORIGIN = 'https://croft.example.test'
const put = (body: object) => PUT(new Request(`${ORIGIN}/api/v1/branding`, {
  method: 'PUT',
  headers: { origin: ORIGIN, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}), { params: Promise.resolve({}) })

const actor = (over: object = {}) => ({
  userId: 'u1', actorId: 'cal@example.test', role: 'admin', actorType: 'human',
  userDisplayName: 'Cal', rateKey: `brand-${Math.random()}`, sessionId: null, ...over,
})

describe('PUT /api/v1/branding', () => {
  beforeEach(() => {
    mocks.authenticate.mockReset().mockResolvedValue(actor())
    mocks.upsert.mockReset().mockResolvedValue({ error: null })
    mocks.invalidate.mockReset()
  })

  it('saves a name and accent for an administrator', async () => {
    const response = await put({ name: 'Dispofi Croft', accent: '#01519B' })
    expect(response.status).toBe(200)
    const [row, options] = mocks.upsert.mock.calls[0]!
    expect(row).toMatchObject({ id: true, name: 'Dispofi Croft', accent: '#01519b', updated_by: 'u1' })
    expect(options).toEqual({ onConflict: 'id' })
    expect(mocks.invalidate).toHaveBeenCalled()
  })

  it('stores the stock name as no name', async () => {
    await put({ name: 'Croft', accent: null })
    expect(mocks.upsert.mock.calls[0]![0]).toMatchObject({ name: null, accent: null })
  })

  it('refuses a colour that is not a hex', async () => {
    const response = await put({ name: null, accent: 'red;}body{display:none' })
    expect(response.status).toBe(400)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it.each([
    ['a member', { role: 'member' }],
    ["an administrator's agent key", { actorType: 'agent' }],
  ])('refuses %s', async (_, over) => {
    mocks.authenticate.mockResolvedValue(actor(over))
    const response = await put({ name: 'Mine now', accent: null })
    expect(response.status).toBe(403)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })
})

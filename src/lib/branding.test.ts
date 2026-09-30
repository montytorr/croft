import { beforeEach, describe, expect, it, vi } from 'vitest'

const maybeSingle = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/client', () => ({
  admin: () => ({ from: () => ({ select: () => ({ maybeSingle }) }) }),
}))
import { STOCK, brandingFrom, getBranding, invalidateBranding } from './branding'

describe('branding from its row', () => {
  const at = '2026-09-28T10:00:00.000Z'

  it('is the stock look with no row', () => {
    expect(brandingFrom(null)).toBe(STOCK)
  })

  it('falls back to the stock name for a blank one, and drops an accent that is not a hex', () => {
    const b = brandingFrom({ name: '  ', accent: 'red', updated_at: at })
    expect(b.name).toBe('Croft')
    expect(b.accent).toBeNull()
    expect(b.palette).toBeNull()
  })

  it('derives the palette, and versions the icons by when the branding last changed', () => {
    const b = brandingFrom({ name: 'Dispofi Croft', accent: '#01519B', updated_at: at })
    expect(b).toMatchObject({ name: 'Dispofi Croft', accent: '#01519b', version: String(Date.parse(at)) })
    expect(b.palette?.light.accent).toBe('#01519b')
  })
})

describe('reading the branding', () => {
  beforeEach(() => {
    invalidateBranding()
    maybeSingle.mockReset()
  })

  it('reads once for many renders, and again after a save clears it', async () => {
    maybeSingle.mockResolvedValue({ data: { name: 'Work', accent: null, updated_at: '2026-09-28' }, error: null })
    await Promise.all([getBranding(), getBranding(), getBranding()])
    expect(maybeSingle).toHaveBeenCalledTimes(1)

    maybeSingle.mockResolvedValue({ data: { name: 'Renamed', accent: null, updated_at: '2026-09-29' }, error: null })
    invalidateBranding()
    expect((await getBranding()).name).toBe('Renamed')
    expect(maybeSingle).toHaveBeenCalledTimes(2)
  })

  it('is the stock look when the table is missing or the query throws', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'relation "instance_branding" does not exist' } })
    expect(await getBranding()).toBe(STOCK)
    invalidateBranding()
    maybeSingle.mockRejectedValue(new Error('connection refused'))
    expect(await getBranding()).toBe(STOCK)
  })
})

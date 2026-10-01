import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/client', () => ({ pool: () => ({ query: vi.fn() }), transaction: vi.fn() }))

import { hashResetToken, maskEmail, resetMail } from './password-reset'

describe('password reset helpers', () => {
  it('masks the address an administrator is told the link went to', () => {
    expect(maskEmail('callum@dispofi.fr')).toBe('ca***@dispofi.fr')
    expect(maskEmail('ab@x.test')).toBe('a***@x.test')
    expect(maskEmail('a@x.test')).toBe('a***@x.test')
    expect(maskEmail('not-an-email')).toBe('***')
  })

  it('stores a sha256 of the token, never the token', () => {
    expect(hashResetToken('token')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashResetToken('token')).not.toContain('token')
  })

  it('names the administrator who asked, escaped, and says who else could have', () => {
    const link = 'https://croft.example.test/reset/abc'
    const asked = resetMail({ link, requestedBy: '<b>Eve</b>' })
    expect(asked.text).toContain('<b>Eve</b>, an administrator')
    expect(asked.html).toContain('&lt;b&gt;Eve&lt;/b&gt;')
    expect(asked.html).not.toContain('<b>Eve</b>')
    expect(asked.text).toContain(link)
    expect(asked.html).toContain(`href="${link}"`)

    const forgot = resetMail({ link, requestedBy: null })
    expect(forgot.text).toContain('If it was not you')
    expect(forgot.text).toContain('60 minutes')
  })
})

import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSealed, openSecret, parseSecretKey, sealSecret, SecretUnreadableError } from './secret-box'

const PURPOSE = 'cairn_connection.api_key'
const HEX = randomBytes(32).toString('hex')

let saved: { secret?: string; signing?: string }

beforeEach(() => {
  saved = { secret: process.env.CROFT_SECRET_KEY, signing: process.env.CROFT_ATTACHMENT_SIGNING_KEY }
  process.env.CROFT_SECRET_KEY = HEX
  delete process.env.CROFT_ATTACHMENT_SIGNING_KEY
})

afterEach(() => {
  const restore = (name: string, value?: string) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore('CROFT_SECRET_KEY', saved.secret)
  restore('CROFT_ATTACHMENT_SIGNING_KEY', saved.signing)
  vi.restoreAllMocks()
})

/** Flips one byte of one base64url part of a sealed value. */
const tamper = (sealed: string, part: 1 | 2 | 3) => {
  const parts = sealed.split(':')
  const bytes = Buffer.from(parts[part]!, 'base64url')
  bytes[0] = (bytes[0] ?? 0) ^ 0x01
  parts[part] = bytes.toString('base64url')
  return parts.join(':')
}

describe('sealing a secret', () => {
  it('round-trips, in the v1 format, never containing the plaintext', () => {
    const sealed = sealSecret('sk_live_abcdef123456', PURPOSE)
    expect(sealed).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/)
    expect(sealed).not.toContain('sk_live')
    expect(isSealed(sealed)).toBe(true)
    expect(openSecret(sealed, PURPOSE)).toBe('sk_live_abcdef123456')
  })

  it('uses a fresh IV every time, so equal secrets do not look equal', () => {
    const a = sealSecret('same', PURPOSE)
    const b = sealSecret('same', PURPOSE)
    expect(a).not.toBe(b)
    expect(openSecret(a, PURPOSE)).toBe(openSecret(b, PURPOSE))
  })

  it('accepts the key as base64 as well as hex', () => {
    const sealed = sealSecret('k', PURPOSE)
    process.env.CROFT_SECRET_KEY = Buffer.from(HEX, 'hex').toString('base64')
    expect(openSecret(sealed, PURPOSE)).toBe('k')
  })

  it('refuses a key that is not 32 bytes', () => {
    expect(() => parseSecretKey('too-short')).toThrow(/32 bytes/)
    expect(() => parseSecretKey(randomBytes(16).toString('hex'))).toThrow(/32 bytes/)
    expect(parseSecretKey(randomBytes(32).toString('base64url'))).toHaveLength(32)
  })
})

describe('detecting tampering', () => {
  it('refuses an altered ciphertext, tag or IV', () => {
    const sealed = sealSecret('sk_live_abcdef123456', PURPOSE)
    for (const part of [1, 2, 3] as const) {
      expect(() => openSecret(tamper(sealed, part), PURPOSE)).toThrow(SecretUnreadableError)
    }
  })

  it('refuses a value sealed for another purpose', () => {
    const sealed = sealSecret('sk_live_abcdef123456', 'something_else.secret')
    expect(() => openSecret(sealed, PURPOSE)).toThrow(SecretUnreadableError)
  })

  it('refuses a value sealed under another key', () => {
    const sealed = sealSecret('sk_live_abcdef123456', PURPOSE)
    process.env.CROFT_SECRET_KEY = randomBytes(32).toString('hex')
    expect(() => openSecret(sealed, PURPOSE)).toThrow(SecretUnreadableError)
  })

  it('refuses something that is not sealed at all', () => {
    expect(isSealed('sk_live_plaintext')).toBe(false)
    expect(() => openSecret('sk_live_plaintext', PURPOSE)).toThrow(SecretUnreadableError)
    expect(() => openSecret('v1:short:short:x', PURPOSE)).toThrow(SecretUnreadableError)
  })
})

describe('without CROFT_SECRET_KEY', () => {
  it('derives the key from the attachment signing key and says so once', () => {
    delete process.env.CROFT_SECRET_KEY
    process.env.CROFT_ATTACHMENT_SIGNING_KEY = 'signing-key-with-enough-entropy'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sealed = sealSecret('sk_live_abcdef123456', PURPOSE)
    expect(openSecret(sealed, PURPOSE)).toBe('sk_live_abcdef123456')
    sealSecret('again', PURPOSE)
    expect(warn.mock.calls.filter(([m]) => String(m).includes('CROFT_SECRET_KEY'))).toHaveLength(1)

    // A different explicit key does not open what the derived one sealed.
    process.env.CROFT_SECRET_KEY = HEX
    expect(() => openSecret(sealed, PURPOSE)).toThrow(SecretUnreadableError)
  })

  it('refuses to seal with no key at all', () => {
    delete process.env.CROFT_SECRET_KEY
    delete process.env.CROFT_ATTACHMENT_SIGNING_KEY
    expect(() => sealSecret('x', PURPOSE)).toThrow(/CROFT_SECRET_KEY/)
  })
})

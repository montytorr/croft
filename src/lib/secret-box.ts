import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Secrets the server must be able to present again — the Cairn API key — are
 * stored sealed, never as they were typed: AES-256-GCM, a fresh 12-byte IV per
 * write, and the purpose bound in as associated data, so a value sealed for
 * one column does not open as another.
 *
 * Stored as `v1:<iv>:<tag>:<ciphertext>`, each part base64url. The version is
 * the format, so a later scheme can be read beside this one.
 *
 * The key is `CROFT_SECRET_KEY` (32 bytes, as 64 hex characters or base64).
 * Unset, it is derived with HKDF from `CROFT_ATTACHMENT_SIGNING_KEY`, which
 * every working instance already has — said once in the log, because rotating
 * that key then makes every sealed value unreadable.
 */

export const SEALED_VERSION = 'v1'

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const HKDF_SALT = 'croft/secret-box'
const HKDF_INFO = 'v1'

export class SecretUnreadableError extends Error {
  constructor(message = 'The stored secret cannot be decrypted with this instance\'s key.') {
    super(message)
    this.name = 'SecretUnreadableError'
  }
}

const HEX_KEY = /^[0-9a-fA-F]{64}$/
const BASE64_KEY = /^[A-Za-z0-9+/_-]+={0,2}$/

/** 32 bytes out of the env value, or a refusal that says what is wrong with it. */
export const parseSecretKey = (raw: string): Buffer => {
  const value = raw.trim()
  if (HEX_KEY.test(value)) return Buffer.from(value, 'hex')
  if (BASE64_KEY.test(value)) {
    const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (bytes.length === KEY_BYTES) return bytes
  }
  throw new Error('CROFT_SECRET_KEY must be 32 bytes, written as 64 hex characters or as base64.')
}

let cached: { source: string; key: Buffer } | null = null
let warnedDerived = false

const secretKey = (): Buffer => {
  const explicit = process.env.CROFT_SECRET_KEY?.trim()
  const signing = process.env.CROFT_ATTACHMENT_SIGNING_KEY
  const source = explicit ? `explicit:${explicit}` : `derived:${signing ?? ''}`
  if (cached?.source === source) return cached.key

  let key: Buffer
  if (explicit) {
    key = parseSecretKey(explicit)
  } else if (signing) {
    key = Buffer.from(hkdfSync('sha256', signing, HKDF_SALT, HKDF_INFO, KEY_BYTES))
    if (!warnedDerived) {
      warnedDerived = true
      console.warn(
        'CROFT_SECRET_KEY is not set: stored secrets are sealed with a key derived from ' +
          'CROFT_ATTACHMENT_SIGNING_KEY, so rotating that key makes them unreadable. ' +
          'Set CROFT_SECRET_KEY to decouple the two.',
      )
    }
  } else {
    throw new Error('CROFT_SECRET_KEY (or CROFT_ATTACHMENT_SIGNING_KEY) is required to store secrets.')
  }
  cached = { source, key }
  return key
}

const b64 = (bytes: Buffer) => bytes.toString('base64url')

/** Seals `plaintext` for `purpose` (e.g. `cairn_connection.api_key`). */
export const sealSecret = (plaintext: string, purpose: string): string => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(purpose, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [SEALED_VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join(':')
}

const PART = /^[A-Za-z0-9_-]*$/

/** Whether a stored value has the sealed shape. Says nothing about whether it opens. */
export const isSealed = (value: string): boolean => {
  const parts = value.split(':')
  return parts.length === 4 && parts[0] === SEALED_VERSION && parts.every((p) => PART.test(p))
}

/**
 * Opens a sealed value. Throws SecretUnreadableError when it was altered,
 * sealed for another purpose, or sealed under another key — never returns
 * something that merely looks like the secret.
 */
export const openSecret = (sealed: string, purpose: string): string => {
  if (!isSealed(sealed)) throw new SecretUnreadableError('The stored secret is not in a sealed format.')
  const [, iv, tag, ciphertext] = sealed.split(':') as [string, string, string, string]
  const ivBytes = Buffer.from(iv, 'base64url')
  const tagBytes = Buffer.from(tag, 'base64url')
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
    throw new SecretUnreadableError('The stored secret is not in a sealed format.')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), ivBytes, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(purpose, 'utf8'))
    decipher.setAuthTag(tagBytes)
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw new SecretUnreadableError()
  }
}

import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from './auth'

/**
 * The Cairn key at rest (073): sealed on every write, and a key stored before
 * 073 read once as plaintext and sealed on the spot.
 *
 * The one row lives here; the fake answers the handful of statements
 * cairn-link issues against it, so what is asserted is what would be stored.
 */
type Row = { url: string | null; api_key: string | null; api_key_plaintext: boolean; last_synced_at: string | null }

const db = vi.hoisted(() => ({ row: null as Row | null, statements: [] as string[] }))

vi.mock('@/lib/db/client', () => ({
  normalizeDatabaseValue: (value: unknown) => value,
  pool: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      db.statements.push(sql)
      if (/^select url, api_key/.test(sql.trim())) return { rows: db.row ? [{ ...db.row }] : [] }
      if (/^insert into cairn_connection/.test(sql.trim())) {
        const [url, sealed, , keepKey] = params as [string | null, string | null, string, boolean]
        const prior = db.row
        db.row = {
          url,
          api_key: keepKey ? prior?.api_key ?? null : sealed,
          api_key_plaintext: keepKey ? prior?.api_key_plaintext ?? false : false,
          last_synced_at: prior?.last_synced_at ?? null,
        }
        return { rows: [] }
      }
      if (/set api_key = \$1, api_key_plaintext = false/.test(sql)) {
        const [sealed, expected] = params as [string, string]
        if (db.row?.api_key_plaintext && db.row.api_key === expected) {
          db.row = { ...db.row, api_key: sealed, api_key_plaintext: false }
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (/from tasks t/.test(sql)) return { rows: [] }
      if (/set last_synced_at = now\(\)/.test(sql)) return { rows: [{ last_synced_at: '2026-09-30T00:00:00Z' }] }
      throw new Error(`unexpected statement: ${sql}`)
    },
  }),
}))

import { saveCairnConnection, syncCairn } from './cairn-link'
import { isSealed, openSecret, sealSecret } from '@/lib/secret-box'

const PURPOSE = 'cairn_connection.api_key'
const KEY = 'sk_live_cairn_key_0123456789'
const actor = {
  userId: 'admin', actorType: 'human', actorId: 'Admin', userDisplayName: 'Admin',
  role: 'admin', rateKey: 'admin', sessionId: null,
} satisfies Actor

/** A fetch that records the key it was handed. */
const recordingFetch = () => {
  const seen: (string | null)[] = []
  const fetcher = (async (_url: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('authorization'))
    return new Response(JSON.stringify({ success: true, data: {} }))
  }) as unknown as typeof fetch
  return { seen, fetcher }
}

beforeEach(() => {
  process.env.CROFT_SECRET_KEY = randomBytes(32).toString('hex')
  db.row = null
  db.statements = []
})

describe('saving the Cairn key', () => {
  it('stores it sealed, and tells nobody what it is', async () => {
    const described = await saveCairnConnection(actor, { url: 'https://cairn.example', apiKey: KEY })
    expect(described).toEqual({ url: 'https://cairn.example', key_set: true, last_synced_at: null })
    expect(db.row?.api_key_plaintext).toBe(false)
    expect(isSealed(db.row!.api_key!)).toBe(true)
    expect(db.row!.api_key).not.toContain(KEY)
    expect(openSecret(db.row!.api_key!, PURPOSE)).toBe(KEY)
  })

  it('clears it with null', async () => {
    await saveCairnConnection(actor, { url: 'https://cairn.example', apiKey: KEY })
    await saveCairnConnection(actor, { url: 'https://cairn.example', apiKey: null })
    expect(db.row).toMatchObject({ api_key: null, api_key_plaintext: false })
  })

  it('seals a legacy plaintext key it was told to keep', async () => {
    db.row = { url: 'https://cairn.example', api_key: KEY, api_key_plaintext: true, last_synced_at: null }
    await saveCairnConnection(actor, { url: 'https://cairn.example/v2' })
    expect(db.row).toMatchObject({ url: 'https://cairn.example/v2', api_key_plaintext: false })
    expect(openSecret(db.row!.api_key!, PURPOSE)).toBe(KEY)
  })
})

describe('reading the Cairn key for a sync', () => {
  it('opens a sealed key without rewriting it', async () => {
    const sealed = sealSecret(KEY, PURPOSE)
    db.row = { url: 'https://cairn.example', api_key: sealed, api_key_plaintext: false, last_synced_at: null }
    expect((await syncCairn(actor, recordingFetch().fetcher)).ok).toBe(true)
    expect(db.row?.api_key).toBe(sealed)
    expect(db.statements.some((s) => /api_key_plaintext = false/.test(s))).toBe(false)
  })

  it('accepts a legacy plaintext key once and seals it in place', async () => {
    db.row = { url: 'https://cairn.example', api_key: KEY, api_key_plaintext: true, last_synced_at: null }
    const synced = await syncCairn(actor, recordingFetch().fetcher)
    expect(synced.ok).toBe(true)
    expect(db.row?.api_key_plaintext).toBe(false)
    expect(db.row!.api_key).not.toBe(KEY)
    expect(openSecret(db.row!.api_key!, PURPOSE)).toBe(KEY)

    // The next read opens the sealed value; nothing is rewritten again.
    db.statements = []
    expect((await syncCairn(actor, recordingFetch().fetcher)).ok).toBe(true)
    expect(db.statements.some((s) => /api_key_plaintext = false/.test(s))).toBe(false)
  })

  it('refuses a tampered key instead of sending something that is not it', async () => {
    const parts = sealSecret(KEY, PURPOSE).split(':')
    const tag = Buffer.from(parts[2]!, 'base64url')
    tag[0] = (tag[0] ?? 0) ^ 0xff
    parts[2] = tag.toString('base64url')
    db.row = { url: 'https://cairn.example', api_key: parts.join(':'), api_key_plaintext: false, last_synced_at: null }
    const { seen, fetcher } = recordingFetch()
    expect(await syncCairn(actor, fetcher)).toEqual({ ok: false, reason: 'key_unreadable' })
    expect(seen).toEqual([])
  })

  it('refuses a key sealed under a key this instance no longer has', async () => {
    db.row = { url: 'https://cairn.example', api_key: sealSecret(KEY, PURPOSE), api_key_plaintext: false, last_synced_at: null }
    process.env.CROFT_SECRET_KEY = randomBytes(32).toString('hex')
    expect(await syncCairn(actor, recordingFetch().fetcher)).toEqual({ ok: false, reason: 'key_unreadable' })
  })
})

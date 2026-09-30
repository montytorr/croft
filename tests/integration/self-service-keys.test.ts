import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Self-service agent keys (CROFT-315): a member lists and revokes their own
 * keys without an administrator, and only their own. Against a real database
 * because the promise that matters — a revoked key is refused on its very next
 * request — lives in the join `authenticate` makes, not in any route.
 *
 * The routes' `authenticate` is swapped for a signed-in browser session per
 * call (there is no cookie jar here); every bearer check below goes through
 * the real one.
 */
const auth = vi.hoisted(() => ({ session: null as null | { userId: string; role: 'admin' | 'member' } }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return {
    ...actual,
    authenticate: async (req: Request) => {
      if (/^Bearer /i.test(req.headers.get('authorization') ?? '')) return actual.authenticate(req)
      if (!auth.session) return null
      return {
        userId: auth.session.userId,
        actorType: 'human' as const,
        actorId: `human-${auth.session.userId}`,
        userDisplayName: 'Someone',
        role: auth.session.role,
        rateKey: `self-keys-${randomUUID()}`,
        sessionId: null,
      }
    },
  }
})

import { pool } from '@/lib/db/client'
import { authenticate } from '@/lib/api/auth'
import { createUserKey, listUserKeys } from '@/lib/api/users'
import { listOwnKeys, revokeOwnKey } from '@/lib/api/own-keys'
import { GET } from '@/app/api/v1/me/keys/route'
import { DELETE } from '@/app/api/v1/me/keys/[keyId]/route'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://croft.example.test'
const memberId = randomUUID()
const otherId = randomUUID()

const bearer = (key: string) =>
  authenticate(new Request(`${ORIGIN}/api/v1/people`, { headers: { authorization: `Bearer ${key}` } }))

const asHuman = (userId: string) => {
  auth.session = { userId, role: 'member' }
}

const listRoute = () => GET(new Request(`${ORIGIN}/api/v1/me/keys`), { params: Promise.resolve({}) })

const revokeRoute = (keyId: string, headers: Record<string, string> = { origin: ORIGIN }) =>
  DELETE(new Request(`${ORIGIN}/api/v1/me/keys/${keyId}`, { method: 'DELETE', headers }), {
    params: Promise.resolve({ keyId }),
  })

beforeAll(async () => {
  for (const [id, name] of [[memberId, 'Key Owner'], [otherId, 'Someone Else']] as const) {
    await pool().query(`insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,'member')`, [
      id,
      `self-keys-${id}@example.test`,
      'not-used',
    ])
    await pool().query('insert into user_profiles (id, display_name) values ($1, $2)', [id, name])
  }
})

afterAll(async () => {
  await pool().query('delete from api_keys where user_id = any($1::uuid[])', [[memberId, otherId]])
  await pool().query('delete from app_users where id = any($1::uuid[])', [[memberId, otherId]])
})

describe('self-service agent keys', () => {
  it('lists only the caller\'s own keys, with no hash and no secret', async () => {
    const mine = await createUserKey(memberId, { agentName: 'claude-code', name: 'claude-code on self-keys-laptop' })
    const theirs = await createUserKey(otherId, { agentName: 'codex', name: 'codex on self-keys-desktop' })

    const listed = await listOwnKeys(memberId)
    expect(listed.map((key) => key.id)).toContain(mine.id)
    expect(listed.map((key) => key.id)).not.toContain(theirs.id)

    asHuman(memberId)
    const response = await listRoute()
    expect(response.status).toBe(200)
    const body = await response.json()
    const found = (body.data as { id: string }[]).find((key) => key.id === mine.id)
    expect(found).toEqual({
      id: mine.id,
      agentName: 'claude-code',
      name: 'claude-code on self-keys-laptop',
      keyPrefix: mine.keyPrefix,
      createdAt: expect.any(String),
      lastUsedAt: null,
      revokedAt: null,
      revoked: false,
    })
    expect(JSON.stringify(body)).not.toContain(mine.key)
    expect(JSON.stringify(body)).not.toMatch(/key_hash|keyHash/)
    expect((body.data as { id: string }[]).map((key) => key.id)).not.toContain(theirs.id)
  })

  it('gives an administrator exactly the shape the owner sees (CROFT-317)', async () => {
    expect(await listUserKeys(memberId)).toEqual(await listOwnKeys(memberId))
  })

  it('refuses an agent key, even the caller\'s own', async () => {
    const mine = await createUserKey(memberId, { agentName: 'codex', name: 'codex on self-keys-agent' })
    const listed = await GET(
      new Request(`${ORIGIN}/api/v1/me/keys`, { headers: { authorization: `Bearer ${mine.key}` } }),
      { params: Promise.resolve({}) },
    )
    expect(listed.status).toBe(403)

    const revoked = await revokeRoute(mine.id, { authorization: `Bearer ${mine.key}` })
    expect(revoked.status).toBe(403)
    expect(await bearer(mine.key)).not.toBeNull()
  })

  it('revokes one of the caller\'s own keys, which is refused on its very next request', async () => {
    const mine = await createUserKey(memberId, { agentName: 'openclaw', name: 'openclaw on self-keys-retired' })
    const sibling = await createUserKey(memberId, { agentName: 'codex', name: 'codex on self-keys-retired' })
    expect(await bearer(mine.key)).toMatchObject({ userId: memberId, actorType: 'agent', agentName: 'openclaw' })

    asHuman(memberId)
    const response = await revokeRoute(mine.id)
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({ id: mine.id, agentName: 'openclaw', revokedAt: expect.any(String) })

    expect(await bearer(mine.key)).toBeNull()
    // Revoking one key disturbs no other, not even on the same host.
    expect(await bearer(sibling.key)).toMatchObject({ agentName: 'codex' })

    const listed = await listOwnKeys(memberId)
    expect(listed.find((key) => key.id === mine.id)?.revokedAt).not.toBeNull()

    // Already revoked reads as not found, the same as the administrator's route.
    expect((await revokeRoute(mine.id)).status).toBe(404)
  })

  it('cannot revoke another person\'s key, and says only that there is no such key', async () => {
    const theirs = await createUserKey(otherId, { agentName: 'codex', name: 'codex on self-keys-not-mine' })

    asHuman(memberId)
    const response = await revokeRoute(theirs.id)
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error).toBe('No such active key.')

    await expect(revokeOwnKey(memberId, theirs.id)).rejects.toMatchObject({ code: 'not_found' })

    const { rows } = await pool().query('select revoked_at from api_keys where id = $1', [theirs.id])
    expect(rows[0].revoked_at).toBeNull()
    expect(await bearer(theirs.key)).toMatchObject({ userId: otherId })
  })

  it('answers 404, not a server error, for a key id that is not a uuid', async () => {
    asHuman(memberId)
    expect((await revokeRoute('not-a-uuid')).status).toBe(404)
  })
})

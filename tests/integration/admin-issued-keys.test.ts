import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * An administrator cannot mint an agent key for someone else (CROFT-16). A key
 * is its holder's identity: minting one for a person would let an administrator
 * read everything that person can see, their private subjects included. People
 * pair their own keys; an administrator keeps listing and revoking, which only
 * ever takes access away.
 */
const auth = vi.hoisted(() => ({ session: null as null | { userId: string; role: 'admin' | 'member' } }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return {
    ...actual,
    authenticate: async () =>
      auth.session
        ? {
            userId: auth.session.userId,
            actorType: 'human' as const,
            actorId: `human-${auth.session.userId}`,
            userDisplayName: 'Someone',
            role: auth.session.role,
            rateKey: `admin-keys-${randomUUID()}`,
            sessionId: null,
          }
        : null,
  }
})

import { pool } from '@/lib/db/client'
import { createUserKey } from '@/lib/api/users'
import { GET, POST } from '@/app/api/v1/users/[id]/keys/route'
import { DELETE } from '@/app/api/v1/users/[id]/keys/[keyId]/route'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://croft.example.test'
const adminId = randomUUID()
const personId = randomUUID()

const keyCount = async (userId: string) =>
  Number((await pool().query('select count(*) from api_keys where user_id = $1', [userId])).rows[0].count)

const mint = (userId: string) =>
  POST(
    new Request(`${ORIGIN}/api/v1/users/${userId}/keys`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ agentName: 'claude-code', name: 'minted by an admin' }),
    }),
    { params: Promise.resolve({ id: userId }) },
  )

beforeAll(async () => {
  for (const [id, role] of [[adminId, 'admin'], [personId, 'member']] as const) {
    await pool().query(`insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)`, [
      id,
      `${id}@example.test`,
      'x',
      role,
    ])
  }
  auth.session = { userId: adminId, role: 'admin' }
})

afterAll(async () => {
  await pool().query('delete from api_keys where user_id = any($1::uuid[])', [[adminId, personId]])
  await pool().query('delete from app_users where id = any($1::uuid[])', [[adminId, personId]])
})

describe('admin-issued keys', () => {
  it('refuses to mint a key for someone else, and creates nothing', async () => {
    const response = await mint(personId)
    expect(response.status).toBe(403)
    const payload = await response.json()
    expect(payload.code).toBe('forbidden')
    expect(payload.error).toContain('croft setup')
    expect(JSON.stringify(payload)).not.toMatch(/sk_live_/)
    expect(await keyCount(personId)).toBe(0)
  })

  it('still lets an administrator list and revoke that person’s keys', async () => {
    const paired = await createUserKey(personId, { agentName: 'codex', name: 'paired by the person' })
    const listed = await (await GET(new Request(`${ORIGIN}/api/v1/users/${personId}/keys`), { params: Promise.resolve({ id: personId }) })).json()
    expect(listed.data.map((k: { id: string }) => k.id)).toContain(paired.id)
    expect(JSON.stringify(listed)).not.toContain(paired.key)

    const revoked = await DELETE(
      new Request(`${ORIGIN}/api/v1/users/${personId}/keys/${paired.id}`, { method: 'DELETE', headers: { origin: ORIGIN } }),
      { params: Promise.resolve({ id: personId, keyId: paired.id }) },
    )
    expect(revoked.status).toBe(200)
  })

  it('still lets an administrator mint their own key', async () => {
    const response = await mint(adminId)
    expect(response.status).toBe(201)
    expect(await keyCount(adminId)).toBe(1)
  })
})

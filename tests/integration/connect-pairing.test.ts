import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import {
  approveConnectRequest,
  ConnectError,
  createConnectRequest,
  denyConnectRequest,
  findConnectRequestByUserCode,
  pollConnectRequest,
} from '@/lib/api/connect'
import { requireHumanActor } from '@/lib/api/connect-route'

/**
 * Browser pairing (CROFT-314): a machine with no credentials gets some for
 * its own agents, once a signed-in human approves it. End to end against a
 * real database, because the interesting failure modes are all races on the
 * row's `status` column that a mocked pool can't exercise honestly.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const otherOwnerId = randomUUID()

beforeAll(async () => {
  for (const [id, name] of [[ownerId, 'Pairing Owner'], [otherOwnerId, 'Someone Else']] as const) {
    await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
      id,
      `connect-${id}@example.test`,
      'not-used',
    ])
    await pool().query('insert into user_profiles (id, display_name) values ($1, $2)', [id, name])
  }
})

afterAll(async () => {
  await pool().query('delete from api_keys where user_id = any($1::uuid[])', [[ownerId, otherOwnerId]])
  await pool().query('delete from connect_requests where approved_by = any($1::uuid[]) or host like $2', [
    [ownerId, otherOwnerId],
    'pairing-test-%',
  ])
  await pool().query('delete from app_users where id = any($1::uuid[])', [[ownerId, otherOwnerId]])
})

const start = (host: string, runtimes = ['claude-code']) =>
  createConnectRequest({ host, runtimes, clientAddress: '203.0.113.9', baseUrl: 'https://croft.example.test' })

describe('device pairing', () => {
  it('creates a request with a redeemable device code and a displayable user code', async () => {
    const created = await start('pairing-test-create')
    expect(created.verificationUrl).toBe(`https://croft.example.test/connect/${created.userCode}`)
    expect(created.expiresIn).toBe(600)
    expect(created.interval).toBe(3)

    // Only the hash is ever on disk.
    const { rows } = await pool().query('select device_code_hash from connect_requests where user_code = $1', [
      created.userCode,
    ])
    expect(rows[0].device_code_hash).not.toBe(created.deviceCode)

    const found = await findConnectRequestByUserCode(created.userCode)
    expect(found).toMatchObject({ host: 'pairing-test-create', status: 'pending', runtimes: ['claude-code'] })
  })

  it('goes create → approve → poll once for the keys → poll again for expired', async () => {
    const created = await start('pairing-test-full', ['claude-code', 'codex'])

    await approveConnectRequest(created.userCode, { runtimes: ['claude-code'], approvedBy: ownerId, approverRole: 'member' })

    const first = await pollConnectRequest(created.deviceCode)
    expect(first.status).toBe('approved')
    if (first.status !== 'approved') throw new Error('unreachable')
    expect(first.user).toMatchObject({ id: ownerId, name: 'Pairing Owner' })
    expect(first.keys).toHaveLength(1)
    expect(first.keys[0]!.agentName).toBe('claude-code')
    expect(first.keys[0]!.key).toMatch(/^sk_live_/)

    // The key actually exists, owned by the approver, named for the pairing.
    const { rows } = await pool().query(
      `select agent_name, name, user_id from api_keys where user_id = $1 and agent_name = 'claude-code'`,
      [ownerId],
    )
    expect(rows).toContainEqual({ agent_name: 'claude-code', name: 'claude-code on pairing-test-full', user_id: ownerId })

    const second = await pollConnectRequest(created.deviceCode)
    expect(second).toEqual({ status: 'expired' })

    const { rows: statusRows } = await pool().query('select status from connect_requests where user_code = $1', [
      created.userCode,
    ])
    expect(statusRows[0].status).toBe('consumed')
  })

  it('denies a request, which then cannot be approved or redeemed', async () => {
    const created = await start('pairing-test-deny')
    await denyConnectRequest(created.userCode)

    await expect(
      approveConnectRequest(created.userCode, { runtimes: ['claude-code'], approvedBy: ownerId, approverRole: 'member' }),
    ).rejects.toMatchObject({ code: 'not_pending' } satisfies Partial<ConnectError>)

    expect(await pollConnectRequest(created.deviceCode)).toEqual({ status: 'denied' })
  })

  it('expires an unapproved request past its expiry, and its device code stops working', async () => {
    const created = await start('pairing-test-expire')
    await pool().query(`update connect_requests set expires_at = now() - interval '1 minute' where user_code = $1`, [
      created.userCode,
    ])

    expect(await pollConnectRequest(created.deviceCode)).toEqual({ status: 'expired' })
    await expect(
      approveConnectRequest(created.userCode, { runtimes: ['claude-code'], approvedBy: ownerId, approverRole: 'member' }),
    ).rejects.toMatchObject({ code: 'not_pending' })
  })

  it('keeps maintenance keys for administrators, and re-checks the role when minting', async () => {
    const asMember = await start('pairing-test-maint-member', ['maintenance'])
    await expect(
      approveConnectRequest(asMember.userCode, { runtimes: ['maintenance'], approvedBy: ownerId, approverRole: 'member' }),
    ).rejects.toMatchObject({ code: 'forbidden_runtime' })

    // Approved while the role claimed admin, but the database says member by
    // the time the keys are minted: nothing is minted.
    const demoted = await start('pairing-test-maint-demoted', ['maintenance'])
    await approveConnectRequest(demoted.userCode, { runtimes: ['maintenance'], approvedBy: ownerId, approverRole: 'admin' })
    await expect(pollConnectRequest(demoted.deviceCode)).resolves.toEqual({ status: 'expired' })

    await pool().query(`update app_users set role = 'admin' where id = $1`, [ownerId])
    try {
      const asAdmin = await start('pairing-test-maint-admin', ['maintenance'])
      await approveConnectRequest(asAdmin.userCode, { runtimes: ['maintenance'], approvedBy: ownerId, approverRole: 'admin' })
      const polled = await pollConnectRequest(asAdmin.deviceCode)
      expect(polled.status).toBe('approved')
      if (polled.status === 'approved') expect(polled.keys.map((k) => k.agentName)).toEqual(['maintenance'])
    } finally {
      await pool().query(`update app_users set role = 'member' where id = $1`, [ownerId])
    }
  })

  it('refuses to approve runtimes outside what was requested', async () => {
    const created = await start('pairing-test-scope', ['claude-code'])
    await expect(
      approveConnectRequest(created.userCode, { runtimes: ['codex'], approvedBy: ownerId, approverRole: 'member' }),
    ).rejects.toMatchObject({ code: 'invalid_runtimes' })
  })

  it('mints keys only for the approving user, never the requester of some other pairing', async () => {
    const created = await start('pairing-test-owner')
    await approveConnectRequest(created.userCode, { runtimes: ['claude-code'], approvedBy: otherOwnerId, approverRole: 'member' })
    const result = await pollConnectRequest(created.deviceCode)
    expect(result.status).toBe('approved')
    if (result.status !== 'approved') throw new Error('unreachable')
    expect(result.user.id).toBe(otherOwnerId)

    const { rows } = await pool().query('select user_id from api_keys where user_id = $1', [otherOwnerId])
    expect(rows).toHaveLength(1)
  })

  // The route (approve/route.ts) is what actually enforces this against a
  // live request — requireHumanActor is the gate it calls, and is exercised
  // in the mocked route test. This documents the same rule at the boundary
  // the lib functions cannot see: they have no actor at all, only whoever
  // the caller says approved it, so "no agent key" has to be enforced above
  // them, before approvedBy is ever chosen.
  it('an agent actor is refused by the route guard before any lib function runs', () => {
    const denied = requireHumanActor({
      userId: ownerId, actorType: 'agent', actorId: 'claude-code · Pairing Owner',
      userDisplayName: 'Pairing Owner', role: 'member', rateKey: 'key:1', sessionId: null,
    })
    expect(denied).not.toBeNull()
    expect(denied?.status).toBe(403)
  })
})

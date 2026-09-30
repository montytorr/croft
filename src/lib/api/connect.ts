import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool, transaction } from '@/lib/db/client'
import { hashesMatch } from './keys'
import { createUserKey } from './users'

/**
 * Browser pairing for a machine's own agents (CROFT-314), OAuth 2.0
 * device-authorization-grant shaped: a CLI with no browser of its own asks
 * for a pairing, shows the person a short code, and polls while they approve
 * it on a device that does have one. Only an administrator could mint keys
 * before this; here the approver mints keys for themself, which is the
 * common "set up my own laptop" case admin-only minting never fit.
 */

export const EXPIRES_IN_SECONDS = 600
export const POLL_INTERVAL_SECONDS = 3

/** No vowels, no 0/1/I/L/O — nothing a person could misread or that spells something unfortunate. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789'

export const RUNTIME_PATTERN = /^[a-z][a-z0-9-]{1,40}$/

/**
 * Runtimes whose key is a grant, not just an identity. A `maintenance` key
 * releases any agent's claim across the workspace (reconcile.ts treats the
 * name itself as the permission, because only an administrator could mint
 * one). Pairing lets anyone mint keys for themself, so these stay
 * administrator-only here too — checked on approval and again at minting,
 * since a role can change in between.
 */
export const PRIVILEGED_RUNTIMES: ReadonlySet<string> = new Set(['maintenance'])

export class ConnectError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_pending' | 'invalid_runtimes' | 'forbidden_runtime',
    message: string,
  ) {
    super(message)
  }
}

const hashDeviceCode = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

const randomUserCode = (): string => {
  const chars = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)])
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

/**
 * What a person typed or a QR code carried, back into the stored shape.
 * Anything that isn't 8 alphabet characters once separators are stripped is
 * returned uppercased-but-unformatted, which is guaranteed to match no row —
 * the lookup fails closed rather than throwing on a malformed code.
 */
export const normalizeUserCode = (input: string): string => {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return stripped.length === 8 ? `${stripped.slice(0, 4)}-${stripped.slice(4)}` : stripped
}

export type ConnectRequestRow = {
  id: string
  device_code_hash: string
  user_code: string
  host: string
  runtimes: string[]
  cli_version: string | null
  client_address: string | null
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired'
  approved_by: string | null
  approved_runtimes: string[] | null
  expires_at: string
  created_at: string
}

/** A row as the approval page reads it: with the expiry decided by Postgres. */
export type ConnectRequestView = ConnectRequestRow & {
  /**
   * Whether `expires_at` has passed, decided in SQL against Postgres's clock
   * rather than the app server's. A `pending` or `approved` row only turns
   * `status = 'expired'` the next time something acts on it — this lets a
   * read-only caller (the approval page) learn the same thing without
   * calling `Date.now()` from render, which the React Compiler rejects as
   * impure, and without writing anything just to answer a read.
   */
  timed_out: boolean
}

const notExpired = (row: Pick<ConnectRequestRow, 'expires_at'>): boolean =>
  new Date(row.expires_at).getTime() > Date.now()

export const createConnectRequest = async (input: {
  host: string
  runtimes: string[]
  cliVersion?: string
  clientAddress: string
  baseUrl: string
}) => {
  // Best-effort housekeeping, on the write path rather than a cron this
  // deployment does not have. A request that never minted anything is done
  // meaning anything a day after it expires. One that did is the record of who
  // approved which host from where, so it stays for a quarter.
  await pool()
    .query(
      `delete from connect_requests
        where (status <> 'consumed' and expires_at < now() - interval '1 day')
           or expires_at < now() - interval '90 days'`,
    )
    .catch(() => undefined)

  const expiresAt = new Date(Date.now() + EXPIRES_IN_SECONDS * 1000)

  // A collision on either random value is retried with fresh randomness for
  // both — device_code_hash is a 32-byte value and never realistically
  // collides, but retrying it alongside user_code costs nothing and means
  // this loop only has one exit condition to reason about.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const deviceCode = randomBytes(32).toString('base64url')
    const deviceCodeHash = hashDeviceCode(deviceCode)
    const userCode = randomUserCode()
    try {
      await pool().query(
        `insert into connect_requests
           (device_code_hash, user_code, host, runtimes, cli_version, client_address, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [deviceCodeHash, userCode, input.host, input.runtimes, input.cliVersion ?? null, input.clientAddress, expiresAt],
      )
      return {
        deviceCode,
        userCode,
        verificationUrl: `${input.baseUrl}/connect/${userCode}`,
        expiresIn: EXPIRES_IN_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      }
    } catch (error) {
      if ((error as { code?: string }).code === '23505') continue
      throw error
    }
  }
  throw new Error('Could not allocate a pairing code.')
}

/** For the approval page: read-only, never mints anything, never consumes. */
export const findConnectRequestByUserCode = async (userCode: string): Promise<ConnectRequestView | null> => {
  const normalized = normalizeUserCode(userCode)
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) return null
  // Only live rows hold a code uniquely; a finished one keeps its code, so the
  // live row wins and the newest after it.
  const { rows } = await pool().query<ConnectRequestView>(
    `select id, device_code_hash, user_code, host, runtimes, cli_version, client_address,
            status, approved_by, approved_runtimes, expires_at, created_at,
            expires_at <= now() as timed_out
       from connect_requests where user_code = $1
      order by (status in ('pending', 'approved')) desc, created_at desc
      limit 1`,
    [normalized],
  )
  return rows[0] ?? null
}

/**
 * Approves some or all of the requested runtimes. A conditional `UPDATE …
 * WHERE status = 'pending' AND expires_at > now()` is the whole guard against
 * approving something already decided or timed out — there is no separate
 * read-then-write for a race to land inside.
 */
export const approveConnectRequest = async (
  userCode: string,
  { runtimes, approvedBy, approverRole }: { runtimes: string[]; approvedBy: string; approverRole: string },
): Promise<void> => {
  const normalized = normalizeUserCode(userCode)
  const request = await findConnectRequestByUserCode(normalized)
  if (!request) throw new ConnectError('not_found', 'No such pairing request.')

  const requested = new Set(request.runtimes)
  const approved = [...new Set(runtimes)]
  if (approved.length === 0 || approved.some((runtime) => !requested.has(runtime))) {
    throw new ConnectError('invalid_runtimes', 'Choose one or more of the runtimes that were requested.')
  }
  const privileged = approved.filter((runtime) => PRIVILEGED_RUNTIMES.has(runtime))
  if (privileged.length > 0 && approverRole !== 'admin') {
    throw new ConnectError(
      'forbidden_runtime',
      `Only an administrator can approve a ${privileged.join(', ')} key: it acts on everyone's work, not just yours.`,
    )
  }

  const result = await pool().query(
    `update connect_requests
        set status = 'approved', approved_by = $2, approved_runtimes = $3, decided_at = now()
      where id = $1 and status = 'pending' and expires_at > now()
      returning id`,
    [request.id, approvedBy, approved],
  )
  if (!result.rows[0]) throw new ConnectError('not_pending', 'This pairing request is no longer pending.')
}

export const denyConnectRequest = async (userCode: string): Promise<void> => {
  const normalized = normalizeUserCode(userCode)
  const request = await findConnectRequestByUserCode(normalized)
  if (!request) throw new ConnectError('not_found', 'No such pairing request.')

  const result = await pool().query(
    `update connect_requests set status = 'denied', decided_at = now()
      where id = $1 and status = 'pending' and expires_at > now()
      returning id`,
    [request.id],
  )
  if (!result.rows[0]) throw new ConnectError('not_pending', 'This pairing request is no longer pending.')
}

export type PollResult =
  | { status: 'pending'; slowDown?: true }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; user: { id: string; email: string; name: string }; keys: { agentName: string; key: string }[] }

/**
 * Polling faster than the advertised interval is allowed through rather than
 * refused — a client that ignores `interval` should not get a wrong answer,
 * just a hint to slow down. Per device code, in memory: losing this on a
 * restart just means one over-eager poll goes uncorrected, which is nothing.
 */
const lastPolledAt = new Map<string, number>()

const tooSoon = (deviceCodeHash: string): boolean => {
  const now = Date.now()
  // A code lives ten minutes; anything older is a code nobody will poll again.
  if (lastPolledAt.size >= 1_000) {
    for (const [hash, at] of lastPolledAt) if (now - at > 15 * 60_000) lastPolledAt.delete(hash)
  }
  const last = lastPolledAt.get(deviceCodeHash)
  lastPolledAt.set(deviceCodeHash, now)
  return last !== undefined && now - last < POLL_INTERVAL_SECONDS * 1000
}

/**
 * The only place keys are minted off a pairing request. Consuming the
 * `approved` row and minting its keys happen in one transaction — the
 * `UPDATE … WHERE status = 'approved' … RETURNING` is the compare-and-swap
 * that makes a second, concurrent poll lose the race and see `expired`
 * rather than a second copy of the same keys.
 */
export const pollConnectRequest = async (deviceCode: string): Promise<PollResult> => {
  const deviceCodeHash = hashDeviceCode(deviceCode)

  // A plain read, no transaction: nearly every poll is `pending`, and a poll
  // is unauthenticated, so it must not hold a pooled transaction open to say so.
  const { rows } = await pool().query<ConnectRequestRow>(
    `select id, device_code_hash, user_code, host, runtimes, cli_version, client_address,
            status, approved_by, approved_runtimes, expires_at, created_at
       from connect_requests where device_code_hash = $1`,
    [deviceCodeHash],
  )
  const row = rows[0]
  // Unknown code doesn't leak existence, and neither does a hash that
  // merely looks right: the index lookup above is exact, so this is a
  // constant-time confirmation of that match, not the primary guard.
  if (!row || !hashesMatch(row.device_code_hash, deviceCodeHash)) return { status: 'expired' }

  if (row.status === 'denied') return { status: 'denied' }
  if (row.status === 'consumed' || row.status === 'expired') return { status: 'expired' }

  if (!notExpired(row)) {
    await pool().query(
      `update connect_requests set status = 'expired' where id = $1 and status in ('pending', 'approved')`,
      [row.id],
    )
    return { status: 'expired' }
  }

  if (row.status === 'pending') {
    // Recorded only for codes that exist, so random guesses leave nothing behind.
    return tooSoon(deviceCodeHash) ? { status: 'pending', slowDown: true } : { status: 'pending' }
  }

  return transaction((client) => mintApprovedKeys(client, row))
}

const mintApprovedKeys = async (client: PoolClient, row: ConnectRequestRow): Promise<PollResult> => {
  // Checked, and the request retired if it fails, *before* the row is
  // flipped to consumed: the approver stopping being a valid keyholder
  // between approving and this poll (deactivated, deleted) has to be a
  // decision this makes deliberately, not a failure discovered mid-mint with
  // the row already marked redeemed and some keys already committed.
  const { rows: userRows } = await client.query<{ id: string; email: string; name: string; role: string }>(
    `select u.id, u.email, coalesce(nullif(trim(p.display_name), ''), u.email) as name, u.role
       from app_users u
       left join user_profiles p on p.id = u.id
      where u.id = $1 and u.deleted_at is null
        and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()`,
    [row.approved_by],
  )
  const approver = userRows[0]
  const privileged = (row.approved_runtimes ?? []).some((runtime) => PRIVILEGED_RUNTIMES.has(runtime))
  if (!approver || (privileged && approver.role !== 'admin')) {
    await client.query(`update connect_requests set status = 'expired' where id = $1 and status = 'approved'`, [row.id])
    return { status: 'expired' }
  }

  const consumed = await client.query<{ approved_runtimes: string[]; host: string }>(
    `update connect_requests set status = 'consumed'
      where id = $1 and status = 'approved'
      returning approved_runtimes, host`,
    [row.id],
  )
  const claim = consumed.rows[0]
  // Lost the race to a concurrent poll of the same device code.
  if (!claim) return { status: 'expired' }

  // Left to throw and roll back the whole transaction — including the
  // consumed flip above — on failure: a request that goes back to 'approved'
  // and can be retried beats one left 'consumed' with some keys minted and
  // none of them ever handed to the caller.
  const keys: { agentName: string; key: string }[] = []
  const user = { id: approver.id, email: approver.email, name: approver.name }
  for (const runtime of claim.approved_runtimes) {
    const created = await createUserKey(user.id, { agentName: runtime, name: `${runtime} on ${claim.host}` }, client)
    keys.push({ agentName: runtime, key: created.key })
  }

  return { status: 'approved', user, keys }
}

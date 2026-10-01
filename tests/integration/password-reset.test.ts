import { createHash, randomUUID } from 'node:crypto'
import { compare, hash } from 'bcryptjs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * v0.5: password resets are email-only, and an administrator cannot take over
 * someone's account (CROFT-19). An administrator can only have a single-use
 * link emailed to the person; cannot set their password or change their email;
 * and never sees a password, a token or a link. "Forgot your password?" sends
 * the same link and answers the same whether or not the address exists.
 *
 * Resend is a stubbed fetch: what it is sent is the only place the link exists.
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
            userDisplayName: 'Ada Admin',
            role: auth.session.role,
            rateKey: `password-reset-${randomUUID()}`,
            sessionId: null,
          }
        : null,
  }
})

import { pool } from '@/lib/db/client'
import { POST as sendResetRoute } from '@/app/api/v1/users/[id]/password-reset/route'
import { POST as setPasswordRoute } from '@/app/api/v1/users/[id]/password/route'
import { PATCH as patchUserRoute } from '@/app/api/v1/users/[id]/route'
import { POST as resetRoute } from '@/app/api/auth/reset/route'
import { POST as forgotRoute } from '@/app/api/auth/forgot/route'
import { INVALID_RESET_LINK } from '@/lib/api/password-reset'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://croft.example.test'
const RUN = randomUUID().slice(0, 8)
const adminId = randomUUID()
const personId = randomUUID()
const otherId = randomUUID()
const disabledId = randomUUID()
const emailOf = (id: string) => `reset-${RUN}-${id.slice(0, 8)}@example.test`
const ORIGINAL_PASSWORD = 'the original password, long enough'

const q = (sql: string, params: unknown[] = []) => pool().query(sql, params)

type Sent = { from: string; to: string[]; subject: string; text: string; html: string; reply_to?: string }
let outbox: Sent[] = []
let resendAnswer: () => Response = () => new Response(JSON.stringify({ id: `msg-${randomUUID()}` }), { status: 200 })
let headersSeen: Headers[] = []

const MAIL_ENV = {
  RESEND_API_KEY: 're_test_secret_never_shown',
  CROFT_MAIL_FROM: 'Croft <croft@example.test>',
  CROFT_BASE_URL: 'https://croft.example.test/',
}

const configureMail = () => {
  for (const [name, value] of Object.entries(MAIL_ENV)) vi.stubEnv(name, value)
}

const linkIn = (mail: Sent) => {
  const match = mail.text.match(/https:\/\/croft\.example\.test\/reset\/([A-Za-z0-9_-]+)/)
  expect(match, 'the email carries the link').not.toBeNull()
  return match![1]!
}

const json = async (response: Response) => {
  const text = await response.text()
  return { status: response.status, text, body: text ? JSON.parse(text) : {} }
}

const sendReset = async (userId: string) =>
  json(
    await sendResetRoute(
      new Request(`${ORIGIN}/api/v1/users/${userId}/password-reset`, { method: 'POST', headers: { origin: ORIGIN } }),
      { params: Promise.resolve({ id: userId }) },
    ),
  )

let address = 0
const nextAddress = () => `203.0.113.${(address += 1)}`

const redeem = async (token: string, password: string, from = nextAddress()) =>
  json(
    await resetRoute(
      new Request(`${ORIGIN}/api/auth/reset`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': from },
        body: JSON.stringify({ token, password }),
      }),
    ),
  )

const forgot = async (email: string, from: string) =>
  json(
    await forgotRoute(
      new Request(`${ORIGIN}/api/auth/forgot`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': from },
        body: JSON.stringify({ email }),
      }),
    ),
  )

const tokensOf = async (userId: string) =>
  (
    await q(
      `select token_hash, purpose, requested_by, used_at, expires_at > now() + interval '59 minutes' as fresh
         from password_reset_tokens where user_id = $1 order by created_at`,
      [userId],
    )
  ).rows

const liveTokens = async (userId: string) =>
  (await tokensOf(userId)).filter((t) => t.used_at === null)

const passwordOf = async (userId: string) =>
  (await q('select encrypted_password, email, session_epoch::text as epoch, auth_epoch::text as auth from app_users where id = $1', [userId])).rows[0]

beforeAll(async () => {
  const encrypted = await hash(ORIGINAL_PASSWORD, 4)
  for (const [id, role] of [[adminId, 'admin'], [personId, 'member'], [otherId, 'member'], [disabledId, 'member']] as const) {
    await q('insert into app_users (id, email, encrypted_password, role) values ($1, $2, $3, $4)', [
      id,
      emailOf(id),
      encrypted,
      role,
    ])
  }
  await q('update app_users set deleted_at = now() where id = $1', [disabledId])
})

beforeEach(() => {
  auth.session = { userId: adminId, role: 'admin' }
  outbox = []
  headersSeen = []
  resendAnswer = () => new Response(JSON.stringify({ id: `msg-${randomUUID()}` }), { status: 200 })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('https://api.resend.com/emails')
    headersSeen.push(new Headers(init.headers))
    outbox.push(JSON.parse(String(init.body)))
    return resendAnswer()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  const ids = [adminId, personId, otherId, disabledId]
  await q('delete from app_sessions where user_id = any($1::uuid[])', [ids])
  await q('delete from app_users where id = any($1::uuid[])', [ids])
})

describe('an administrator cannot set a credential', () => {
  it('refuses to set someone else’s password, and changes nothing', async () => {
    const before = await passwordOf(personId)
    const response = await json(
      await setPasswordRoute(
        new Request(`${ORIGIN}/api/v1/users/${personId}/password`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'an administrator chose this one' }),
        }),
        { params: Promise.resolve({ id: personId }) },
      ),
    )
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('forbidden')
    expect(response.body.error).toContain('password-reset')
    expect(await passwordOf(personId)).toEqual(before)
  })

  it('still lets an administrator set their own', async () => {
    const response = await setPasswordRoute(
      new Request(`${ORIGIN}/api/v1/users/${adminId}/password`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'my own brand new password' }),
      }),
      { params: Promise.resolve({ id: adminId }) },
    )
    expect(response.status).toBe(200)
    expect(await compare('my own brand new password', (await passwordOf(adminId)).encrypted_password)).toBe(true)
  })

  it('refuses to change someone else’s email, and still edits the rest', async () => {
    const patch = (id: string, body: unknown) =>
      patchUserRoute(
        new Request(`${ORIGIN}/api/v1/users/${id}`, {
          method: 'PATCH',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      )
    const refused = await json(await patch(personId, { email: `attacker-${RUN}@example.test`, displayName: 'Renamed' }))
    expect(refused.status).toBe(403)
    expect(refused.body.code).toBe('forbidden')
    expect((await passwordOf(personId)).email).toBe(emailOf(personId))
    expect((await q('select display_name from user_profiles where id = $1', [personId])).rows[0]?.display_name ?? null)
      .not.toBe('Renamed')

    expect((await patch(personId, { displayName: 'Pat Person' })).status).toBe(200)

    const mine = await patch(adminId, { email: `admin-renamed-${RUN}@example.test` })
    expect(mine.status).toBe(200)
    await q('update app_users set email = $2 where id = $1', [adminId, emailOf(adminId)])
  })
})

describe('sending a reset link', () => {
  it('answers 503 mail_not_configured and creates nothing when mail is not set up', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    vi.stubEnv('CROFT_MAIL_FROM', '')
    const response = await sendReset(personId)
    expect(response.status).toBe(503)
    expect(response.body.code).toBe('mail_not_configured')
    expect(response.body.error).toContain('RESEND_API_KEY')
    expect(outbox).toEqual([])
    expect(await tokensOf(personId)).toEqual([])
  })

  it('treats a missing CROFT_BASE_URL as not configured, never building the link from the Host', async () => {
    configureMail()
    vi.stubEnv('CROFT_BASE_URL', '')
    const response = await sendReset(personId)
    expect(response.status).toBe(503)
    expect(response.body.code).toBe('mail_not_configured')
    expect(await tokensOf(personId)).toEqual([])
  })

  it('emails the person a link the administrator never sees', async () => {
    configureMail()
    const response = await sendReset(personId)
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({ sent: true, to: `re***@example.test` })

    expect(outbox).toHaveLength(1)
    const [mail] = outbox
    expect(mail).toMatchObject({ from: MAIL_ENV.CROFT_MAIL_FROM, to: [emailOf(personId)] })
    expect(mail!.text).toContain('Ada Admin')
    expect(headersSeen[0]!.get('authorization')).toBe(`Bearer ${MAIL_ENV.RESEND_API_KEY}`)
    const token = linkIn(mail!)
    expect(mail!.html).toContain(`/reset/${token}`)
    expect(response.text).not.toContain(token)
    expect(response.text).not.toContain(MAIL_ENV.RESEND_API_KEY)

    const rows = await tokensOf(personId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      token_hash: createHash('sha256').update(token).digest('hex'),
      purpose: 'admin_reset',
      requested_by: adminId,
      used_at: null,
      fresh: true,
    })
  })

  it('invalidates the earlier link when a new one is sent', async () => {
    configureMail()
    await sendReset(otherId)
    const first = linkIn(outbox[0]!)
    await sendReset(otherId)
    const second = linkIn(outbox[1]!)
    expect(second).not.toBe(first)
    expect(await liveTokens(otherId)).toHaveLength(1)

    const stale = await redeem(first, 'a password for the stale link')
    expect(stale.status).toBe(400)
    expect(stale.body).toMatchObject({ code: 'invalid_token', error: INVALID_RESET_LINK })
    await q('update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null', [otherId])
  })

  it('answers 502 mail_send_failed and leaves no live link when Resend refuses', async () => {
    configureMail()
    resendAnswer = () =>
      new Response(JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'The from domain is not verified.' }), {
        status: 422,
      })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const response = await sendReset(otherId)
      expect(response.status).toBe(502)
      expect(response.body.code).toBe('mail_send_failed')
      expect(response.body.error).toContain('The from domain is not verified.')
      expect(response.text).not.toContain(MAIL_ENV.RESEND_API_KEY)
      expect(JSON.stringify(errors.mock.calls)).not.toContain(MAIL_ENV.RESEND_API_KEY)
    } finally {
      errors.mockRestore()
    }
    expect(outbox).toHaveLength(1)
    const token = linkIn(outbox[0]!)
    expect(await liveTokens(otherId)).toEqual([])
    expect((await redeem(token, 'a password nobody received')).body.code).toBe('invalid_token')
  })

  it('refuses a disabled user, an unknown one, and anyone but a human administrator', async () => {
    configureMail()
    expect((await sendReset(disabledId)).status).toBe(409)
    expect((await sendReset(randomUUID())).status).toBe(404)
    expect((await sendReset('not-a-uuid')).status).toBe(404)
    auth.session = { userId: otherId, role: 'member' }
    expect((await sendReset(personId)).status).toBe(403)
    expect(outbox).toEqual([])
    expect(await tokensOf(disabledId)).toEqual([])
  })
})

describe('redeeming a reset link', () => {
  const issue = async (userId: string) => {
    configureMail()
    outbox = []
    expect((await sendReset(userId)).status).toBe(200)
    return linkIn(outbox[0]!)
  }

  it('sets the password once, spends the link and signs the person out everywhere', async () => {
    const token = await issue(personId)
    for (const n of [1, 2]) {
      await q(
        `insert into app_sessions (user_id, token_hash, expires_at, session_epoch)
         select id, $2, now() + interval '1 day', session_epoch from app_users where id = $1`,
        [personId, createHash('sha256').update(`session-${RUN}-${n}`).digest('hex')],
      )
    }
    const before = await passwordOf(personId)

    const short = await redeem(token, 'too short')
    expect(short.status).toBe(400)
    expect(short.body.code).toBe('validation_failed')
    expect(await liveTokens(personId)).toHaveLength(1)

    const done = await redeem(token, 'the person chose this new password')
    expect(done.status).toBe(200)
    expect(done.body).toEqual({ ok: true })

    const after = await passwordOf(personId)
    expect(await compare('the person chose this new password', after.encrypted_password)).toBe(true)
    expect(Number(after.epoch)).toBe(Number(before.epoch) + 1)
    expect(after.auth).toBe(before.auth)
    expect((await q('select count(*)::int as n from app_sessions where user_id = $1', [personId])).rows[0].n).toBe(0)
    expect(await liveTokens(personId)).toEqual([])

    const again = await redeem(token, 'trying the same link twice')
    expect(again.status).toBe(400)
    expect(again.body).toMatchObject({ code: 'invalid_token', error: INVALID_RESET_LINK })
    expect(await compare('the person chose this new password', (await passwordOf(personId)).encrypted_password)).toBe(true)
  })

  it('gives an expired, unknown, malformed or disabled user’s link the same answer', async () => {
    const expired = await issue(personId)
    await q(`update password_reset_tokens set expires_at = now() - interval '1 second' where user_id = $1 and used_at is null`, [personId])

    const disabledToken = await issue(otherId)
    await q('update app_users set deleted_at = now() where id = $1', [otherId])

    try {
      const answers = [
        await redeem(expired, 'a long enough password'),
        await redeem('A'.repeat(43), 'a long enough password'),
        await redeem('not a token!', 'a long enough password'),
        await redeem(disabledToken, 'a long enough password'),
      ]
      for (const answer of answers) {
        expect(answer.status).toBe(400)
        expect(answer.body).toMatchObject({ code: 'invalid_token', error: INVALID_RESET_LINK })
      }
      expect(await compare(ORIGINAL_PASSWORD, (await passwordOf(otherId)).encrypted_password)).toBe(true)
    } finally {
      await q('update app_users set deleted_at = null where id = $1', [otherId])
    }
  })

  it('dies when the user is disabled or changes their password another way', async () => {
    const token = await issue(otherId)
    configureMail()
    // Disabling invalidates the user's outstanding links (deactivateUser).
    const { deactivateUser, restoreUser } = await import('@/lib/api/users')
    await deactivateUser(otherId, { by: { userId: adminId, actorType: 'human', actorId: 'Ada Admin' } })
    await restoreUser(otherId)
    expect((await redeem(token, 'a long enough password')).body.code).toBe('invalid_token')
  })

  it('is refused from another origin and limited per address', async () => {
    const foreign = await resetRoute(
      new Request(`${ORIGIN}/api/auth/reset`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'A'.repeat(43), password: 'a long enough password' }),
      }),
    )
    expect(foreign.status).toBe(403)

    const from = nextAddress()
    const statuses: number[] = []
    for (let i = 0; i < 11; i += 1) statuses.push((await redeem('B'.repeat(43), 'a long enough password', from)).status)
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})

describe('forgot your password', () => {
  it('answers the same for an address that exists and one that does not', async () => {
    configureMail()
    const known = await forgot(emailOf(personId).toUpperCase(), nextAddress())
    const unknown = await forgot(`nobody-${RUN}@example.test`, nextAddress())
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(known.body).toEqual({ ok: true })
    expect(unknown.text).toBe(known.text)

    await vi.waitFor(async () => expect(outbox).toHaveLength(1))
    expect(outbox[0]!.to).toEqual([emailOf(personId)])
    expect(outbox[0]!.text).toContain('If it was not you')
    const live = await liveTokens(personId)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ purpose: 'forgot', requested_by: null })

    const token = linkIn(outbox[0]!)
    expect((await redeem(token, 'remembered a new one at last')).status).toBe(200)
  })

  it('sends nothing for a disabled user', async () => {
    configureMail()
    expect((await forgot(emailOf(disabledId), nextAddress())).body).toEqual({ ok: true })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(outbox).toEqual([])
    expect(await tokensOf(disabledId)).toEqual([])
  })

  it('stops sending to one address after three an hour, without saying so', async () => {
    configureMail()
    const answers = []
    for (let i = 0; i < 4; i += 1) answers.push((await forgot(emailOf(otherId), nextAddress())).text)
    expect(new Set(answers).size).toBe(1)
    await vi.waitFor(async () => expect(outbox).toHaveLength(3))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(outbox).toHaveLength(3)
    expect(await liveTokens(otherId)).toHaveLength(1)
  })

  it('limits one client address with a 429 that names no account', async () => {
    configureMail()
    const from = nextAddress()
    const statuses: number[] = []
    for (let i = 0; i < 6; i += 1) statuses.push((await forgot(`nobody-${i}-${RUN}@example.test`, from)).status)
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
  })

  it('says mail is not set up, the same for every address, and creates nothing', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    const before = (await tokensOf(personId)).length
    const known = await forgot(emailOf(personId), nextAddress())
    const unknown = await forgot(`nobody-${RUN}@example.test`, nextAddress())
    expect(known.status).toBe(503)
    expect(known.body.code).toBe('mail_not_configured')
    expect(unknown.text).toBe(known.text)
    expect((await tokensOf(personId)).length).toBe(before)
  })
})

import { createHash, randomBytes } from 'node:crypto'
import { pool, transaction } from '@/lib/db/client'
import { escapeHtml, mailBaseUrl, mailConfigurationProblem, sendMail } from '@/lib/mail'
import { setPasswordOn } from './users'

/**
 * Password resets are email-only (v0.5). Nobody sets anyone else's password:
 * an administrator can only have a single-use link sent to the person, and
 * anyone can ask for their own from the sign-in page. The link is the only
 * copy of the token — the database keeps its sha256 — so an administrator
 * never sees a password, a token or a link.
 *
 * Break-glass for an operator with a shell on the host is
 * scripts/reset-password.mjs, which writes the same kind of token and prints
 * the link to that shell's stdout.
 */

export const RESET_TTL_MINUTES = 60

/** One message for unknown, used, expired and superseded links alike. */
export const INVALID_RESET_LINK = 'This reset link is invalid or has expired. Ask for a new one.'

export type ResetPurpose = 'admin_reset' | 'forgot'

export class PasswordResetError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'mail_not_configured' | 'mail_send_failed',
    message: string,
  ) {
    super(message)
  }
}

export const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** `ca***@dispofi.fr`: enough to say where it went, not a copy of the address. */
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  return `${local.slice(0, local.length > 2 ? 2 : 1)}***${email.slice(at)}`
}

const ACTIVE = `deleted_at is null and coalesce(banned_until, '-infinity'::timestamptz) <= now()`

type Recipient = { id: string; email: string; active: boolean }

/**
 * A fresh token for an active user, with every earlier unused one of theirs
 * invalidated in the same transaction: only the newest link ever works. The
 * user row is locked, so two requests at once take turns rather than racing
 * the one-live-token index. Null when the user is no longer active.
 */
const issueToken = async (userId: string, purpose: ResetPurpose, requestedBy: string | null) =>
  transaction(async (client) => {
    const user = await client.query(`select id from app_users where id = $1 and ${ACTIVE} for update`, [userId])
    if (!user.rows[0]) return null
    await client.query('update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null', [
      userId,
    ])
    const token = randomBytes(32).toString('base64url')
    const inserted = await client.query<{ id: string }>(
      `insert into password_reset_tokens (user_id, token_hash, requested_by, purpose, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(mins => $5)) returning id`,
      [userId, hashResetToken(token), requestedBy, purpose, RESET_TTL_MINUTES],
    )
    return { id: inserted.rows[0]!.id, token }
  })

const invalidateToken = (id: string) =>
  pool().query('update password_reset_tokens set used_at = now() where id = $1 and used_at is null', [id])

export const resetMail = ({ link, requestedBy }: { link: string; requestedBy: string | null }) => {
  const why = requestedBy
    ? `${requestedBy}, an administrator of this Croft, asked for a password reset link to be sent to you.`
    : 'Someone asked to reset the password of your Croft account. If it was not you, ignore this email: your password has not changed.'
  const expiry = `The link works once, for the next ${RESET_TTL_MINUTES} minutes. Setting a new password signs you out everywhere.`
  return {
    subject: 'Reset your Croft password',
    text: `${why}\n\nChoose a new password here:\n${link}\n\n${expiry}\n`,
    html:
      `<p>${escapeHtml(why)}</p>` +
      `<p><a href="${escapeHtml(link)}">Choose a new password</a></p>` +
      `<p style="color:#666;font-size:13px">${escapeHtml(expiry)}<br>${escapeHtml(link)}</p>`,
  }
}

const deliver = async (
  user: Recipient,
  purpose: ResetPurpose,
  by: { userId: string; name: string } | null,
) => {
  const issued = await issueToken(user.id, purpose, by?.userId ?? null)
  if (!issued) return { ok: false as const, code: 'conflict' as const, error: 'The user is no longer active.' }
  const link = `${mailBaseUrl()}/reset/${issued.token}`
  const sent = await sendMail({ to: user.email, ...resetMail({ link, requestedBy: by?.name ?? null }) })
  if (!sent.ok) {
    // A link nobody received must not stay redeemable.
    await invalidateToken(issued.id)
    return sent
  }
  return { ok: true as const }
}

/**
 * `POST /api/v1/users/{id}/password-reset`. Creates nothing when mail is not
 * set up; invalidates the token it made when the send fails.
 */
export const sendAdminPasswordReset = async (
  userId: string,
  by: { userId: string; userDisplayName: string },
): Promise<{ sent: true; to: string }> => {
  const problem = mailConfigurationProblem()
  if (problem) throw new PasswordResetError('mail_not_configured', problem)
  const { rows } = await pool().query<Recipient>(
    `select id, email, (${ACTIVE}) as active from app_users where id = $1`,
    [userId],
  )
  const user = rows[0]
  if (!user) throw new PasswordResetError('not_found', 'No such user.')
  if (!user.active) {
    throw new PasswordResetError('conflict', 'A reset link cannot be sent to a disabled user. Restore them first.')
  }
  const sent = await deliver(user, 'admin_reset', { userId: by.userId, name: by.userDisplayName })
  if (!sent.ok) {
    if (sent.code === 'mail_send_failed') {
      throw new PasswordResetError('mail_send_failed', `The reset email could not be sent: ${sent.error}`)
    }
    throw new PasswordResetError(sent.code === 'mail_not_configured' ? 'mail_not_configured' : 'conflict', sent.error)
  }
  return { sent: true, to: maskEmail(user.email) }
}

/**
 * `POST /api/auth/forgot`. Says nothing either way: the caller answers the
 * same whether or not the address belongs to anyone, and runs this without
 * waiting on it, so neither the answer nor its timing tells them.
 */
export const sendForgotPasswordReset = async (email: string): Promise<void> => {
  if (mailConfigurationProblem()) return
  const { rows } = await pool().query<Recipient>(
    `select id, email, true as active from app_users where lower(email) = lower($1) and ${ACTIVE} limit 1`,
    [email.trim()],
  )
  const user = rows[0]
  if (!user) return
  const sent = await deliver(user, 'forgot', null)
  if (!sent.ok && sent.code !== 'mail_send_failed') console.error(`[auth] forgot-password not sent: ${sent.error}`)
}

/**
 * `POST /api/auth/reset`. Sets the password, spends the token and every other
 * outstanding one of the user's, and signs them out everywhere (the same
 * effect as any password change: session epoch, sessions deleted). False for a
 * token that is unknown, used, expired, superseded, or whose user is no longer
 * active — the caller says one thing for all of them.
 */
export const consumePasswordReset = async (token: string, password: string): Promise<boolean> =>
  transaction(async (client) => {
    const { rows } = await client.query<{ id: string; user_id: string }>(
      `select t.id, t.user_id
         from password_reset_tokens t
         join app_users u on u.id = t.user_id
        where t.token_hash = $1 and t.used_at is null and t.expires_at > now()
          and u.deleted_at is null and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()
        for update of t`,
      [hashResetToken(token)],
    )
    const found = rows[0]
    if (!found) return false
    await client.query('update password_reset_tokens set used_at = now() where id = $1', [found.id])
    await setPasswordOn(client, found.user_id, password)
    return true
  })

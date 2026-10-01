#!/usr/bin/env node
/**
 * Break-glass password reset, for an operator with a shell on the host:
 *
 *   node scripts/reset-password.mjs <email>
 *   docker exec -it <croft-container> node scripts/reset-password.mjs <email>
 *
 * Prints a one-time reset LINK to this shell's stdout — never over the web, and
 * never a password. It is the same single-use, one-hour token the app emails
 * (src/lib/api/password-reset.ts), and invalidates any earlier one the person
 * had. Open it, or hand it to the person over a channel you trust.
 *
 * Exists so that a Croft without mail set up, or one whose only administrator
 * is locked out, can still be recovered — by someone who already holds the
 * database, which is a stronger position than the web admin role. The web role
 * alone can never set or see a credential.
 *
 * Needs DATABASE_URL and CROFT_BASE_URL (or --base-url <url>).
 */
import { createHash, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

const TTL_MINUTES = 60

const ACTIVE = `deleted_at is null and coalesce(banned_until, '-infinity'::timestamptz) <= now()`

export const createResetLink = async ({ url, email, baseUrl }) => {
  if (!url) throw new Error('DATABASE_URL is not set.')
  if (!email || !email.includes('@')) throw new Error('usage: node scripts/reset-password.mjs <email> [--base-url <url>]')
  let base
  try {
    base = new URL(baseUrl ?? '')
  } catch {
    throw new Error('CROFT_BASE_URL is not set (or pass --base-url https://croft.example.com): it builds the link.')
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('the base URL must be http(s).')

  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('begin')
    const found = await client.query(
      `select id, email, (${ACTIVE}) as active from app_users where lower(email) = lower($1) for update`,
      [email.trim()],
    )
    const user = found.rows[0]
    if (!user) throw new Error(`no user with the email ${email}.`)
    if (!user.active) {
      throw new Error(`${user.email} is disabled. Restore them (Users page, or clear deleted_at/banned_until) first.`)
    }
    await client.query('update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null', [
      user.id,
    ])
    const token = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    await client.query(
      `insert into password_reset_tokens (user_id, token_hash, requested_by, purpose, expires_at)
       values ($1, $2, null, 'admin_reset', now() + make_interval(mins => $3))`,
      [user.id, tokenHash, TTL_MINUTES],
    )
    await client.query('commit')
    return { email: user.email, link: `${base.origin}${base.pathname.replace(/\/+$/, '')}/reset/${token}` }
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }
}

const argValue = (args, flag) => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const flagged = new Set(['--base-url', argValue(args, '--base-url')])
  const email = args.find((arg) => !flagged.has(arg))?.trim()
  createResetLink({
    url: process.env.DATABASE_URL,
    email,
    baseUrl: argValue(args, '--base-url') ?? process.env.CROFT_BASE_URL?.trim(),
  })
    .then(({ email: who, link }) => {
      console.log(`One-time reset link for ${who} (valid ${TTL_MINUTES} minutes, single use):`)
      console.log(link)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}

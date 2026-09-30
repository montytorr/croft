#!/usr/bin/env node
/**
 * The first administrator, or a reset of one: there is no public sign-up.
 *
 * `npm run operator:create` upserts the account named by CROFT_OPERATOR_* and
 * rotates its browser sessions. scripts/start.mjs uses the same function with
 * `onlyIfNoAdmin`, for a platform where nobody can run a command beside the
 * database: it creates the account once, and never resets a password on a
 * later start just because the variables are still set.
 */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { hash } from 'bcryptjs'
import pg from 'pg'

const OPERATOR_LOCK = 7_261_694

export const ensureOperator = async ({ url, email, password, displayName = null, onlyIfNoAdmin = false }) => {
  if (!url) throw new Error('DATABASE_URL is not set.')
  if (!email || !email.includes('@')) throw new Error('an operator email is required.')
  if (!password || password.length < 12) throw new Error('the operator password must be at least 12 characters.')

  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('begin')
    // Held to the end of the transaction, so containers bootstrapping at the
    // same moment take turns: the first creates the account, the rest then
    // see it and do nothing, instead of racing to insert the same email.
    await client.query('select pg_advisory_xact_lock($1)', [OPERATOR_LOCK])
    if (onlyIfNoAdmin) {
      const admins = await client.query(`select 1 from app_users where role = 'admin' and deleted_at is null limit 1`)
      if (admins.rows.length > 0) {
        await client.query('rollback')
        return 'exists'
      }
    }
    const existing = await client.query('select id from app_users where lower(email) = lower($1)', [email])
    const id = existing.rows[0]?.id || randomUUID()
    const encrypted = await hash(password, 12)
    if (existing.rows[0]) {
      await client.query(
        `update app_users set email = $1, encrypted_password = $2, role = 'admin',
         session_epoch = session_epoch + 1, banned_until = null, deleted_at = null, updated_at = now()
         where id = $3`,
        [email, encrypted, id],
      )
    } else {
      await client.query(
        `insert into app_users (id, email, encrypted_password, role)
         values ($1, $2, $3, 'admin')`,
        [id, email, encrypted],
      )
    }
    await client.query(
      `insert into user_profiles (id, display_name) values ($1, $2)
       on conflict (id) do update set display_name = excluded.display_name`,
      [id, displayName],
    )
    await client.query('commit')
    return existing.rows[0] ? 'updated' : 'created'
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    await client.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const email = process.env.CROFT_OPERATOR_EMAIL?.trim()
  ensureOperator({
    url: process.env.DATABASE_URL,
    email,
    password: process.env.CROFT_OPERATOR_PASSWORD,
    displayName: process.env.CROFT_OPERATOR_NAME?.trim() || null,
  })
    .then(() => console.log(`operator ready: ${email}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exit(1)
    })
}

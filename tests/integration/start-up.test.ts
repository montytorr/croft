import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM scripts, run by the container without a TS loader
import { migrate } from '../../scripts/migrate.mjs'
// @ts-expect-error plain ESM scripts, run by the container without a TS loader
import { ensureOperator } from '../../scripts/create-operator.mjs'

/**
 * The start-up chores a platform with no one-off tasks runs in every
 * container (scripts/start.mjs): migrations, and the first administrator.
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const tag = randomUUID().replace(/-/g, '').slice(0, 10)
const table = `start_up_probe_${tag}`
const names = [`zzzz_${tag}_a.sql`, `zzzz_${tag}_b.sql`]
const dirs: string[] = []
const emails: string[] = []
const quiet = () => {}

afterAll(async () => {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  await client.query(`drop table if exists ${table}`)
  await client.query('delete from _croft_migrations where name = any($1)', [names])
  for (const email of emails) {
    await client.query('delete from user_profiles where id in (select id from app_users where email = $1)', [email])
    await client.query('delete from app_users where email = $1', [email])
  }
  await client.end()
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

describe('migrating from several containers at once', () => {
  /**
   * Without the advisory lock both runners see the same unapplied file, both
   * apply it, and the second fails on the `_croft_migrations` primary key —
   * which on App Runner is a container that refuses to start.
   */
  it('applies each migration once and lets every runner start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'croft-migrations-'))
    dirs.push(dir)
    await writeFile(join(dir, names[0]!), `create table ${table} (n int); select pg_sleep(0.3);`)
    await writeFile(join(dir, names[1]!), `insert into ${table} values (1);`)

    const results = await Promise.all([1, 2, 3].map(() => migrate(databaseUrl, { dir, log: quiet })))

    expect(results.reduce((a: number, b: number) => a + b, 0)).toBe(2)
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    const { rows } = await client.query(`select count(*)::int as n from ${table}`)
    await client.end()
    expect(rows[0].n).toBe(1)
  })
})

describe('the first administrator', () => {
  it('is created once, and a later start never resets its password', async () => {
    const email = `bootstrap-${tag}@example.test`
    emails.push(email)
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    const { rows: before } = await client.query(`select count(*)::int as n from app_users where role = 'admin' and deleted_at is null`)
    await client.end()

    const first = await ensureOperator({ url: databaseUrl, email, password: 'a-long-password-1', onlyIfNoAdmin: true })
    // Whatever the database held before, an administrator now exists...
    expect(before[0].n > 0 ? 'exists' : 'created').toBe(first)
    await ensureOperator({ url: databaseUrl, email, password: 'a-long-password-1' })
    // ...so a restart with the variables still set changes nothing.
    const second = await ensureOperator({ url: databaseUrl, email, password: 'a-different-password', onlyIfNoAdmin: true })
    expect(second).toBe('exists')
  })

  /**
   * Containers starting together all bootstrap at once. Without a lock they
   * all see no account, all insert the same email, and all but one crash on
   * the unique constraint — a crash loop on the very first deploy.
   */
  it('lets containers bootstrapping at the same moment take turns', async () => {
    const email = `race-${tag}@example.test`
    emails.push(email)
    const outcomes = await Promise.all([1, 2, 3, 4].map(() =>
      ensureOperator({ url: databaseUrl, email, password: 'a-long-password-1' })))
    expect(outcomes.filter((o: string) => o === 'created')).toHaveLength(1)
    expect(outcomes.filter((o: string) => o === 'updated')).toHaveLength(3)
  })

  it('refuses a short password before touching the database', async () => {
    await expect(ensureOperator({ url: databaseUrl, email: 'x@example.test', password: 'short', onlyIfNoAdmin: true }))
      .rejects.toThrow('at least 12 characters')
  })
})

#!/usr/bin/env node
/**
 * Applies migrations/*.sql in filename order, inside a transaction,
 * recording what has run in a `_croft_migrations` table.
 *
 * Deliberately plain: numbered SQL files are easier to reason about than a
 * generated migration chain, and they are what the self-hosting instructions
 * tell people to run.
 *
 * Plain JavaScript, so the runtime image can run it without a TypeScript
 * loader: a platform with no one-off task (App Runner) migrates on start, in
 * scripts/start.mjs. That means several containers can start at once, so the
 * whole run holds an advisory lock — one applies, the others wait and then
 * find nothing left to apply.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

// Any fixed number; every runner has to contend on the same one.
const MIGRATION_LOCK = 7_261_693

export const migrate = async (url, { dir = join(process.cwd(), 'migrations'), log = console.log } = {}) => {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    // Session-level: released when the connection closes, however this ends.
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK])
    await client.query(`
      create table if not exists _croft_migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      )
    `)

    const { rows } = await client.query('select name from _croft_migrations')
    const applied = new Set(rows.map((r) => r.name))
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

    let ran = 0
    for (const file of files) {
      if (applied.has(file)) continue
      const sql = await readFile(join(dir, file), 'utf8')
      log(`applying ${file}`)
      try {
        await client.query('begin')
        await client.query(sql)
        await client.query('insert into _croft_migrations (name) values ($1)', [file])
        await client.query('commit')
        ran += 1
      } catch (error) {
        await client.query('rollback')
        throw new Error(`failed on ${file}: ${error instanceof Error ? error.message : error}`)
      }
    }
    log(ran === 0 ? 'nothing to apply' : `applied ${ran} migration(s)`)
    return ran
  } finally {
    await client.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. See .env.example.')
    process.exit(1)
  }
  migrate(url).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}

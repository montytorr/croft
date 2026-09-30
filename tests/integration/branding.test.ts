import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Migration 066 against a real database: branding is one row for the whole
 * instance, and the table itself refuses what the API would refuse — so a
 * row written by hand, or by a future route that forgets a check, cannot put
 * a non-colour into the stylesheet every page renders.
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

let client: Client

beforeAll(async () => {
  const name = `croft_branding_${randomUUID().replaceAll('-', '')}`
  const root = new Client({ connectionString: databaseUrl })
  await root.connect()
  await root.query(`create database "${name}"`)
  await root.end()
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  client = new Client({ connectionString: url.toString() })
  await client.connect()
  const files = (await readdir(join(process.cwd(), 'migrations'))).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
})

afterAll(async () => {
  await client?.end()
})

const refused = async (sql: string, params: unknown[] = []) => {
  await client.query('savepoint s')
  try {
    await client.query(sql, params)
    return false
  } catch {
    return true
  } finally {
    await client.query('rollback to savepoint s')
  }
}

describe('instance_branding', () => {
  it('holds one row, upserted on its constant key', async () => {
    await client.query('begin')
    try {
      await client.query(`insert into instance_branding (name, accent) values ('Dispofi Croft', '#01519b')`)
      await client.query(
        `insert into instance_branding (id, name) values (true, 'Renamed')
         on conflict (id) do update set name = excluded.name`,
      )
      const { rows } = await client.query('select name, accent from instance_branding')
      expect(rows).toEqual([{ name: 'Renamed', accent: '#01519b' }])
      expect(await refused(`insert into instance_branding (id) values (false)`)).toBe(true)
    } finally {
      await client.query('rollback')
    }
  })

  it('refuses anything that is not a lower-case six-digit hex', async () => {
    await client.query('begin')
    try {
      for (const accent of ['red', '#FFF', '#01519B', '#01519b;}', '#01519b0']) {
        expect(await refused(`insert into instance_branding (accent) values ($1)`, [accent]), accent).toBe(true)
      }
    } finally {
      await client.query('rollback')
    }
  })

  it('refuses a blank or overlong name', async () => {
    await client.query('begin')
    try {
      expect(await refused(`insert into instance_branding (name) values ('   ')`)).toBe(true)
      expect(await refused(`insert into instance_branding (name) values ($1)`, ['x'.repeat(61)])).toBe(true)
    } finally {
      await client.query('rollback')
    }
  })
})

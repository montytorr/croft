import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { recallCounts, unusedKnowledge } from '@/lib/api/knowledge-use'

/**
 * Per-entry recall counts (CROFT-270), from the rows 053 records, against the
 * installed `knowledge_recall_counts`.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const AGENT = 'claude-code · counts@example.test'
const slug = (name: string) => `counts-${name}-${suffix}`
const ids: Record<string, string> = {}

const entry = async (name: string, age: string) => {
  const { rows } = await pool().query(
    `insert into knowledge (owner_user_id, slug, title, body, actor_type, actor_id, created_at)
     values ($1, $2, $3, '', 'agent', $4, now() - $5::interval) returning id`,
    [ownerId, slug(name), `Counts ${name}`, AGENT, age],
  )
  ids[name] = rows[0].id as string
}

const searched = (returned: string[], age = '1 day') =>
  pool().query(
    `insert into search_events (owner_user_id, actor_id, query, kinds, result_count, widened, returned_slugs, created_at)
     values ($1, $2, 'q', null, $3, false, $4, now() - $5::interval)`,
    [ownerId, AGENT, returned.length, returned, age],
  )

const read = (spelled: string, hit: boolean, age = '1 day') =>
  pool().query(
    `insert into knowledge_reads (owner_user_id, actor_id, slug, hit, created_at)
     values ($1, $2, $3, $4, now() - $5::interval)`,
    [ownerId, AGENT, spelled, hit, age],
  )

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `counts-${ownerId}@example.test`,
    'not-used',
  ])
  await entry('busy', '90 days')
  await entry('stale', '90 days')
  await entry('forgotten', '90 days')
  await entry('young', '2 days')
  await entry('older-recalled', '90 days')
  await entry('never-recalled-limited', '60 days')

  await searched([slug('busy'), 'CROFT-1', slug('busy')])
  await searched([slug('busy')], '2 days')
  await read(slug('busy'), true)
  // Spelled the way [[a_b]] references are, and resolved on read.
  await read(slug('busy').replace(/-/g, '_'), true)
  await read(slug('busy'), false)

  await searched([slug('stale')], '60 days')
  await searched([slug('older-recalled')], '45 days')
})

afterAll(async () => {
  await pool().query('delete from search_events where owner_user_id = $1', [ownerId])
  await pool().query('delete from knowledge_reads where owner_user_id = $1', [ownerId])
  await pool().query('delete from knowledge where owner_user_id = $1', [ownerId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('recall counts', () => {
  it('counts searches that returned an entry and hits that read it, underscores included', async () => {
    const counts = await recallCounts([ids.busy!])
    // Listed twice in one search counts twice: it was returned in two rows.
    expect(counts.get(ids.busy!)).toMatchObject({ returned: 3, read: 2 })
    expect(counts.get(ids.busy!)?.lastRecalled).not.toBeNull()
  })

  it('counts only inside the window', async () => {
    expect((await recallCounts([ids.stale!])).get(ids.stale!)).toMatchObject({ returned: 0, read: 0 })
    expect((await recallCounts([ids.stale!], 90)).get(ids.stale!)).toMatchObject({ returned: 1 })
  })

  it('lists what nobody was given, never-recalled first, and not what is too young to judge', async () => {
    const unused = (await unusedKnowledge(30, 100_000)).filter((u) => u.slug.endsWith(suffix))
    // Never recalled first (oldest entry first among them), then oldest recall.
    // busy was recalled inside the window and young has not had the chance.
    expect(unused.map((u) => u.slug)).toEqual([
      slug('forgotten'),
      slug('never-recalled-limited'),
      slug('stale'),
      slug('older-recalled'),
    ])
    expect(unused.find((u) => u.slug === slug('stale'))?.lastRecalled).not.toBeNull()
    expect(unused.find((u) => u.slug === slug('never-recalled-limited'))?.lastRecalled).toBeNull()
  })

  it('ranks before it limits: an older, once-recalled entry never crowds out a never-recalled one', async () => {
    // Other suites share this database, so assert against the ranking itself
    // rather than assuming these rows are the only unused ones.
    const all = (await unusedKnowledge(30, 100_000)).map((u) => u.slug)
    const target = all.indexOf(slug('never-recalled-limited'))
    expect(target).toBeGreaterThanOrEqual(0)
    expect(all.indexOf(slug('older-recalled'))).toBeGreaterThan(target)

    const limited = (await unusedKnowledge(30, target + 1)).map((u) => u.slug)
    expect(limited.at(-1)).toBe(slug('never-recalled-limited'))
    expect(limited).not.toContain(slug('older-recalled'))
  })
})

describe('knowledge_recall_state (062)', () => {
  const lastRecalledAt = async (name: string) => {
    const { rows } = await pool().query(
      'select last_recalled_at from knowledge_recall_state where knowledge_id = $1',
      [ids[name]],
    )
    return (rows[0]?.last_recalled_at as Date | undefined) ?? null
  }
  const updatedAt = async (name: string) => {
    const { rows } = await pool().query('select updated_at from knowledge where id = $1', [ids[name]])
    return (rows[0].updated_at as Date).toISOString()
  }

  it('agrees with the all-time count for every fixture, so the fast path and the audit path cannot drift', async () => {
    const everything = await recallCounts(Object.values(ids), Number.POSITIVE_INFINITY)
    for (const name of Object.keys(ids)) {
      const stored = await lastRecalledAt(name)
      const counted = everything.get(ids[name]!)?.lastRecalled ?? null
      expect(stored ? stored.toISOString() : null, name).toBe(counted)
    }
  })

  it('moves forward on a search or a hit, never back, and ignores a miss', async () => {
    await entry('touched', '90 days')
    expect(await lastRecalledAt('touched')).toBeNull()

    await read(slug('touched'), false, '3 days')
    expect(await lastRecalledAt('touched')).toBeNull()

    await searched([slug('touched')], '10 days')
    const afterSearch = await lastRecalledAt('touched')
    expect(afterSearch).not.toBeNull()

    await read(slug('touched').replace(/-/g, '_'), true, '5 days')
    const afterRead = await lastRecalledAt('touched')
    expect(afterRead!.getTime()).toBeGreaterThan(afterSearch!.getTime())

    await searched([slug('touched')], '20 days')
    expect((await lastRecalledAt('touched'))!.getTime()).toBe(afterRead!.getTime())
  })

  it('never makes a recall look like an edit: search, hit and miss all leave updated_at alone', async () => {
    await entry('untouched', '90 days')
    const before = await updatedAt('untouched')

    await searched([slug('untouched')], '0 days')
    await read(slug('untouched'), true, '0 days')
    await read(slug('untouched'), false, '0 days')

    expect(await lastRecalledAt('untouched')).not.toBeNull()
    expect(await updatedAt('untouched')).toBe(before)
  })

  it('the backfill restores recall state without touching knowledge rows', async () => {
    const names = Object.keys(ids)
    const before = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await updatedAt(n)])))
    const expected = await recallCounts(Object.values(ids), Number.POSITIVE_INFINITY)

    await pool().query('delete from knowledge_recall_state where knowledge_id = any($1)', [Object.values(ids)])
    await pool().query('select knowledge_recall_state_backfill()')

    for (const name of names) {
      const stored = await lastRecalledAt(name)
      expect(stored ? stored.toISOString() : null, name).toBe(expected.get(ids[name]!)?.lastRecalled ?? null)
      expect(await updatedAt(name), name).toBe(before[name])
    }
  })

  it('a real edit still advances updated_at', async () => {
    const before = await updatedAt('untouched')
    await pool().query(`update knowledge set title = title || ' (edited)' where id = $1`, [ids.untouched])
    expect(new Date(await updatedAt('untouched')).getTime()).toBeGreaterThan(new Date(before).getTime())
  })
})

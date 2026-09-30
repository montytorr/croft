import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { createKnowledge, linkedFiles, updateKnowledge } from '@/lib/api/knowledge'
import { contextForFile } from '@/lib/api/files'
import { filesNamedIn, stalenessFor } from '@/lib/api/staleness'
import type { Actor } from '@/lib/api/auth'

/**
 * Knowledge-to-file links (CROFT-269), against the installed trigger.
 *
 * The body rule exists twice — `filesNamedIn` for reading, `knowledge_paths_in`
 * for the trigger that stores links — so the first thing held here is that
 * they give the same answers. Two regex engines drifting apart is the failure
 * nobody would see: links would quietly stop matching what staleness reads.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const taskId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const KEY = `KF${suffix}`
const SLUG = `files-test-${suffix}`
const SOURCED = `files-sourced-${suffix}`
const unique = `kf${suffix}`

const actor = {
  userId: ownerId,
  actorType: 'agent',
  actorId: 'claude-code · files@example.test',
  userDisplayName: 'Files',
  role: 'admin',
  rateKey: `files-${ownerId}`,
  sessionId: null,
} as unknown as Actor

const idOf = async (slug: string) =>
  (await pool().query('select id from knowledge where slug = $1', [slug])).rows[0].id as string

const linksOf = async (slug: string) => {
  const { rows } = await pool().query(
    `select path, origin from knowledge_files where knowledge_id = $1 order by origin, path`,
    [await idOf(slug)],
  )
  return rows
}

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `files-${ownerId}@example.test`,
    'not-used',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title, task_counter) values ($1,$2,$3,'Files',1)`,
    [projectId, ownerId, KEY],
  )
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status)
     values ($1,$2,1,'Did the work','agent',$3,'done')`,
    [taskId, projectId, actor.actorId],
  )
  await pool().query(
    `insert into file_touches (owner_user_id, path, task_id) values ($1, $2, $3)`,
    [ownerId, `src/${unique}/touched.ts`, taskId],
  )
})

afterAll(async () => {
  await pool().query('delete from knowledge where slug = any($1)', [[SLUG, SOURCED]])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('knowledge_paths_in agrees with filesNamedIn', () => {
  const bodies = [
    'see `src/lib/api/staleness.ts` and `~/.croft/projects.json`',
    'not `croft check`, not `owner/repo`, not `README`',
    '`./scripts/migrate.ts` and `../up/one.md` and `/etc/hosts.conf`',
    '`  padded/path/file.tsx  ` with spaces around it',
    '```sql\nselect 1 from `a/b.sql`\n```',
    'an unterminated `src/x.ts and then `a/b.ts`',
    '`with space/in it.ts` and `v1.2/notes.md` and `a/b.TOOLONGEXT`',
    '`@scope/pkg/index.js`, `a//b.md`, `x/y.md/`',
    'no backticks at all: src/plain.ts',
  ]

  for (const body of bodies) {
    it(JSON.stringify(body).slice(0, 60), async () => {
      // Sorted here, not in SQL: collation order is not JavaScript's.
      const { rows } = await pool().query('select p from knowledge_paths_in($1) as p', [body])
      expect(rows.map((r) => r.p as string).sort()).toEqual([...filesNamedIn(body)].sort())
    })
  }
})

describe('knowledge_files', () => {
  it('links the paths a body names, normalised the way touches are', async () => {
    await createKnowledge(actor, {
      slug: SLUG,
      title: 'Files test',
      body: `about \`./src/${unique}/named.ts\``,
      labels: [],
      projects: [],
      entities: [],
      files: [`src/${unique}/explicit.ts`],
    })
    expect(await linksOf(SLUG)).toEqual([
      { path: `src/${unique}/named.ts`, origin: 'body' },
      { path: `src/${unique}/explicit.ts`, origin: 'explicit' },
    ])
  })

  it('links what the source task touched', async () => {
    await createKnowledge(actor, {
      slug: SOURCED,
      title: 'Sourced',
      body: 'no paths here',
      labels: [],
      projects: [],
      entities: [],
      sourceTaskRef: `${KEY}-1`,
    })
    expect(await linksOf(SOURCED)).toEqual([{ path: `src/${unique}/touched.ts`, origin: 'source' }])
  })

  it('follows the body when it changes, and leaves the explicit files alone', async () => {
    await updateKnowledge(actor, SLUG, { body: `now about \`src/${unique}/renamed.ts\`` })
    expect(await linksOf(SLUG)).toEqual([
      { path: `src/${unique}/renamed.ts`, origin: 'body' },
      { path: `src/${unique}/explicit.ts`, origin: 'explicit' },
    ])
  })

  it('replaces the explicit files only when they are given', async () => {
    await updateKnowledge(actor, SLUG, { verified: true })
    expect((await linksOf(SLUG)).filter((l) => l.origin === 'explicit')).toHaveLength(1)

    await updateKnowledge(actor, SLUG, { files: [] })
    expect((await linksOf(SLUG)).filter((l) => l.origin === 'explicit')).toEqual([])
  })

  it('answers "what do we know about this file", by path and by basename', async () => {
    const exact = await contextForFile(ownerId, `src/${unique}/renamed.ts`)
    expect(exact.knowledge.map((k) => k.slug)).toContain(SLUG)

    const fromElsewhere = await contextForFile(ownerId, `/srv/checkout/src/${unique}/touched.ts`)
    expect(fromElsewhere.knowledge.map((k) => k.slug)).toContain(SOURCED)
  })

  it('writes no touch, so linking a file never ages another fact', async () => {
    const { rows } = await pool().query(
      `select count(*)::int as n from file_touches where path like $1 and task_id is null`,
      [`%${unique}%`],
    )
    expect(rows[0].n).toBe(0)
  })

  it('feeds staleness with the explicit files too', async () => {
    await updateKnowledge(actor, SLUG, { files: [`src/${unique}/only-explicit.ts`] })
    const id = await idOf(SLUG)
    expect((await linkedFiles([id])).get(id)).toContain(`src/${unique}/only-explicit.ts`)

    const row = (await pool().query('select id, body, verified_at, created_at from knowledge where id = $1', [id]))
      .rows[0]
    const aged = await stalenessFor(ownerId, [row])
    expect(aged.get(id)?.files).toContain(`src/${unique}/only-explicit.ts`)
  })
})

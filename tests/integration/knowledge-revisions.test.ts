import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { createKnowledge, knowledgeRevisions, updateKnowledge } from '@/lib/api/knowledge'
import type { Actor } from '@/lib/api/auth'

/**
 * A correction keeps what it corrected (CROFT-266).
 *
 * The revision is written inside the edit's transaction from a row read `for
 * update`, and the feed reads it through an in-place edit of `activity_feed`.
 * Both are claims about installed SQL, which the unit suite mocks away.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const KEY = `KR${suffix}`
const SLUG = `revisions-test-${suffix}`
const REPLACEMENT = `revisions-replacement-${suffix}`

const actorFor = (actorId: string) =>
  ({
    userId: ownerId,
    actorType: 'agent',
    actorId,
    userDisplayName: 'Revisions',
    role: 'admin',
    rateKey: `revisions-${ownerId}`,
    sessionId: null,
  }) as unknown as Actor

const author = actorFor('codex · first@example.test')
const editor = actorFor('claude-code · second@example.test')

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `revisions-${ownerId}@example.test`,
    'not-used',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title, task_counter) values ($1,$2,$3,'Revisions',0)`,
    [projectId, ownerId, KEY],
  )
  await createKnowledge(author, {
    slug: SLUG,
    title: 'Pool size is 15',
    body: 'The pooler caps at 15.',
    labels: ['postgres'],
    projects: [],
    entities: [],
  })
  await createKnowledge(author, {
    slug: REPLACEMENT,
    title: 'Pool size is per tenant',
    body: 'Per tenant.',
    labels: [],
    projects: [],
    entities: [],
  })
})

afterAll(async () => {
  await pool().query('delete from knowledge where slug = any($1)', [[SLUG, REPLACEMENT]])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

const revisions = async () => (await knowledgeRevisions(ownerId, SLUG))?.revisions ?? []

describe('knowledge revisions', () => {
  it('starts with none', async () => {
    expect(await revisions()).toEqual([])
  })

  it('keeps the replaced body, credited to whoever replaced it, with the reason', async () => {
    await updateKnowledge(editor, SLUG, {
      title: 'Pool size is 40',
      body: 'Raised to 40.',
      reason: 'the cap was the default, not a limit',
    })

    const [latest, ...rest] = await revisions()
    expect(rest).toEqual([])
    expect(latest).toMatchObject({
      revision: 1,
      title: 'Pool size is 15',
      body: 'The pooler caps at 15.',
      labels: ['postgres'],
      projects: [],
      change: 'relearned',
      edited_by_type: 'agent',
      edited_by: editor.actorId,
      reason: 'the cap was the default, not a limit',
    })
  })

  it('records nothing for a verify, or for a save that changes nothing', async () => {
    await updateKnowledge(editor, SLUG, { verified: true })
    // What the browser sends on every save: every field, unchanged.
    await updateKnowledge(editor, SLUG, {
      title: 'Pool size is 40',
      body: 'Raised to 40.',
      labels: ['postgres'],
      projects: [],
      entities: [],
    })
    expect(await revisions()).toHaveLength(1)
  })

  it('treats labels as a set, so reordering them is not a new version', async () => {
    await updateKnowledge(editor, SLUG, { labels: ['postgres', 'pooling'] })
    await updateKnowledge(editor, SLUG, { labels: ['pooling', 'postgres'] })
    expect((await revisions()).map((r) => r.change)).toEqual(['relearned', 'relearned'])
    // Back to what the rest of this file expects.
    await updateKnowledge(editor, SLUG, { labels: ['postgres'] })
    await pool().query(
      `delete from knowledge_revisions where knowledge_id = (select id from knowledge where slug = $1) and revision > 1`,
      [SLUG],
    )
  })

  it('calls a scope-only change a rescope, and keeps the old scope as keys', async () => {
    await updateKnowledge(editor, SLUG, { projects: [KEY] })
    await updateKnowledge(editor, SLUG, { projects: [] })

    const [second, first] = await revisions()
    expect(first).toMatchObject({ revision: 2, change: 'rescoped', projects: [] })
    expect(second).toMatchObject({ revision: 3, change: 'rescoped', projects: [KEY] })
  })

  it('tells a supersession from its reversal', async () => {
    await updateKnowledge(editor, SLUG, { supersededBy: REPLACEMENT })
    await updateKnowledge(author, SLUG, { supersededBy: null })

    const [reinstated, superseded] = await revisions()
    expect(superseded).toMatchObject({ revision: 4, change: 'superseded', superseded_by: null })
    expect(reinstated).toMatchObject({ revision: 5, change: 'reinstated', edited_by: author.actorId })
    expect(reinstated?.superseded_by).not.toBeNull()
  })

  it('numbers concurrent edits without colliding', async () => {
    await Promise.all([
      updateKnowledge(editor, SLUG, { body: 'race a' }),
      updateKnowledge(author, SLUG, { body: 'race b' }),
    ])
    const numbers = (await revisions()).map((r) => r.revision)
    expect(numbers.slice(0, 2)).toEqual([7, 6])
  })

  it('credits each correction in the feed to its editor, under the title it produced', async () => {
    const { rows } = await pool().query(
      `select at, actor, ref, title, detail from activity_feed($1, null, 500, null, null, array['knowledge'])
        where ref = $2 order by at`,
      [ownerId, SLUG],
    )
    expect(rows[0]).toMatchObject({ actor: author.actorId, title: 'Pool size is 15', detail: 'learned' })
    expect(rows[1]).toMatchObject({ actor: editor.actorId, title: 'Pool size is 40', detail: 'relearned' })
    expect(rows.map((r) => r.detail)).toContain('superseded')
    expect(rows.map((r) => r.detail)).toContain('reinstated')
    expect(rows).toHaveLength(1 + 7)
  })

  it('leaves an entry never revised exactly as the feed showed it before', async () => {
    const { rows } = await pool().query(
      `select actor, detail from activity_feed($1, null, 500, null, null, array['knowledge'])
        where ref = $2`,
      [ownerId, REPLACEMENT],
    )
    expect(rows).toEqual([{ actor: author.actorId, detail: 'learned' }])
  })
})

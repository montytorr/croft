import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { mentionsOf } from '@/lib/api/mentions'

/**
 * Backlinks (CROFT-267): a ref written anywhere on one task is readable from
 * the task it names. Filled by triggers, so every assertion here is about the
 * installed SQL — the unit suite cannot see a trigger at all.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const OLD = `MO${suffix}`
const KEY = `MN${suffix}`
const AGENT = 'claude-code · mentions@example.test'

const ids = { target: randomUUID(), decider: randomUUID(), chatter: randomUUID(), closer: randomUUID() }

const addTask = async (id: string, number: number, title: string, description: string | null = null) =>
  pool().query(
    `insert into tasks (id, project_id, number, title, description, actor_type, actor_id, status)
     values ($1,$2,$3,$4,$5,'agent',$6,'todo')`,
    [id, projectId, number, title, description, AGENT],
  )

const addNote = async (taskId: string, note: string, kind = 'note') => {
  const { rows } = await pool().query(
    `insert into task_notes (task_id, actor_type, actor_id, note, kind)
     values ($1,'agent',$2,$3,$4) returning id`,
    [taskId, AGENT, note, kind],
  )
  return rows[0].id as string
}

const mentionsOfTarget = async () => (await mentionsOf(ids.target)).mentions

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `mentions-${ownerId}@example.test`,
    'not-used',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title, task_counter) values ($1,$2,$3,'Mentions',4)`,
    [projectId, ownerId, OLD],
  )
  await addTask(ids.target, 1, 'The one being talked about')
  await addTask(ids.decider, 2, 'Decided something about it')
  await addTask(ids.chatter, 3, 'Passing mention')
  await addTask(ids.closer, 4, 'Closed with a reference')
  // Renamed after filing, so old refs are ones people actually wrote.
  await pool().query('select project_rename_key($1, $2, $3)', [projectId, KEY, AGENT])
})

afterAll(async () => {
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('task mentions', () => {
  it('reads a note on one task back from the task it names', async () => {
    await addNote(ids.chatter, `looked at ${KEY}-1 briefly, unrelated`)
    const [m] = await mentionsOfTarget()
    expect(m).toMatchObject({ ref: `${KEY}-3`, source: 'note', kind: 'note', writtenAs: `${KEY}-1` })
    expect(m?.excerpt).toContain(`${KEY}-1`)
  })

  it('resolves a ref written under the retired key', async () => {
    await addNote(
      ids.decider,
      `CONFLICT with ${OLD}-1: the decision here does NOT generalise to its case.`,
      'finding',
    )
    const found = (await mentionsOfTarget()).find((m) => m.ref === `${KEY}-2`)
    expect(found).toMatchObject({ kind: 'finding', writtenAs: `${OLD}-1` })
  })

  it('puts decisions, findings and resolutions ahead of a passing mention', async () => {
    await pool().query(`update tasks set resolution = $1, status = 'done' where id = $2`, [
      `fixed; same root cause as ${KEY}-1`,
      ids.closer,
    ])
    const order = (await mentionsOfTarget()).map((m) => m.ref)
    expect(order.at(-1)).toBe(`${KEY}-3`)
    expect(order.slice(0, 2).sort()).toEqual([`${KEY}-2`, `${KEY}-4`])
  })

  it('ignores refs that name no task, and a task naming itself', async () => {
    await addNote(ids.target, `UTF-8 and HTTP-404 and ${KEY}-999 and ${KEY}-1 itself`)
    const { rows } = await pool().query(
      'select count(*)::int as n from task_mentions where source_task_id = $1',
      [ids.target],
    )
    expect(rows[0].n).toBe(0)
  })

  it('forgets a ref an edited description no longer carries', async () => {
    await pool().query('update tasks set description = $1 where id = $2', [`see ${KEY}-1`, ids.chatter])
    expect((await mentionsOfTarget()).filter((m) => m.source === 'description')).toHaveLength(1)

    await pool().query('update tasks set description = $1 where id = $2', ['no refs now', ids.chatter])
    expect((await mentionsOfTarget()).filter((m) => m.source === 'description')).toHaveLength(0)
  })

  it('goes when the note that made it goes', async () => {
    const noteId = await addNote(ids.chatter, `one more about ${KEY}-1`)
    const before = (await mentionsOf(ids.target)).total
    await pool().query('delete from task_notes where id = $1', [noteId])
    expect((await mentionsOf(ids.target)).total).toBe(before - 1)
  })

  it('counts a ref once per note, however often it is repeated', async () => {
    const noteId = await addNote(ids.chatter, `${KEY}-1, ${KEY}-1 and again ${KEY}-1`)
    const { rows } = await pool().query('select count(*)::int as n from task_mentions where note_id = $1', [noteId])
    expect(rows[0].n).toBe(1)
  })
})

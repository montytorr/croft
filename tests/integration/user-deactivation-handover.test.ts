import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { deactivateUser } from '@/lib/api/users'

/**
 * Disabling a user never leaves their open tasks with an assignee nobody can
 * reach (CROFT-310): it is refused until someone is named to take them over,
 * and the hand-over and its history land in the same transaction.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const adminId = randomUUID()
const leaverId = randomUUID()
const successorId = randomUUID()
const projectId = randomUUID()
const openTask = randomUUID()
const doingTask = randomUUID()
const doneTask = randomUUID()

const by = { userId: adminId, actorType: 'human' as const, actorId: 'Handover Admin' }

beforeAll(async () => {
  for (const [id, name] of [[adminId, 'Handover Admin'], [leaverId, 'Leaver'], [successorId, 'Successor']]) {
    await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
      id,
      `handover-${id}@example.test`,
      'not-used',
    ])
    await pool().query('insert into user_profiles (id, display_name) values ($1, $2)', [id, name])
  }
  await pool().query(
    `insert into projects (id, owner_user_id, key, title) values ($1,$2,'HAND','Handover')`,
    [projectId, adminId],
  )
  for (const [id, number, status] of [[openTask, 1, 'todo'], [doingTask, 2, 'doing'], [doneTask, 3, 'done']]) {
    await pool().query(
      `insert into tasks (id, project_id, number, title, status, actor_id, assignee_user_id)
       values ($1,$2,$3,$4,$5,'codex · someone',$6)`,
      [id, projectId, number, `task ${number}`, status, leaverId],
    )
  }
})

afterAll(async () => {
  await pool().query('delete from task_activity_events where project_id = $1', [projectId])
  await pool().query('delete from tasks where project_id = $1', [projectId])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = any($1::uuid[])', [[adminId, leaverId, successorId]])
})

const assignees = async () => {
  const { rows } = await pool().query<{ id: string; assignee_user_id: string }>(
    'select id, assignee_user_id from tasks where project_id = $1',
    [projectId],
  )
  return new Map(rows.map((row) => [row.id, row.assignee_user_id]))
}

describe('deactivating an assignee', () => {
  it('refuses while the user owns open tasks and nobody is named, and changes nothing', async () => {
    await expect(deactivateUser(leaverId, { by })).rejects.toMatchObject({
      code: 'open_tasks',
      details: { openTaskCount: 2 },
    })
    const { rows } = await pool().query('select deleted_at from app_users where id = $1', [leaverId])
    expect(rows[0].deleted_at).toBeNull()
  })

  it('hands the open tasks over, leaves closed ones, and records who and why', async () => {
    const result = await deactivateUser(leaverId, { by, reassignTo: successorId })
    expect(result).toMatchObject({ active: false, openTaskCount: 0, reassignedTaskCount: 2 })

    const now = await assignees()
    expect(now.get(openTask)).toBe(successorId)
    expect(now.get(doingTask)).toBe(successorId)
    expect(now.get(doneTask)).toBe(leaverId)

    const { rows } = await pool().query(
      `select task_id, owner_user_id, actor_id, data from task_activity_events
        where project_id = $1 and event = 'assignee_changed' order by task_id`,
      [projectId],
    )
    expect(rows.map((row) => row.task_id).sort()).toEqual([openTask, doingTask].sort())
    for (const row of rows) {
      expect(row.owner_user_id).toBe(adminId)
      expect(row.actor_id).toBe('Handover Admin')
      expect(row.data).toEqual({
        from: leaverId,
        to: successorId,
        from_name: 'Leaver',
        to_name: 'Successor',
        reason: 'user_deactivated',
      })
    }
  })
})

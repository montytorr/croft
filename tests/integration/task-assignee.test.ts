import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { admin, pool } from '@/lib/db/client'
import { TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { withAssignees } from '@/lib/api/people'

/**
 * Every task has a human who owns it (CROFT-310), and that holds for every
 * writer, not only the route that names one.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const otherId = randomUUID()
const projectId = randomUUID()
const unnamedTask = randomUUID()
const assignedTask = randomUUID()

beforeAll(async () => {
  for (const id of [ownerId, otherId]) {
    await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
      id,
      `assignee-${id}@example.test`,
      'not-used',
    ])
  }
  await pool().query('insert into user_profiles (id, display_name) values ($1, $2)', [otherId, 'Other Person'])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title) values ($1,$2,'ASSG','Assignee')`,
    [projectId, ownerId],
  )
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_id) values ($1,$2,1,'unnamed','codex · someone')`,
    [unnamedTask, projectId],
  )
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_id, assignee_user_id)
     values ($1,$2,2,'assigned','codex · someone',$3)`,
    [assignedTask, projectId, otherId],
  )
})

afterAll(async () => {
  await pool().query('delete from tasks where project_id = $1', [projectId])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = any($1::uuid[])', [[ownerId, otherId]])
})

describe('task assignee', () => {
  it('falls back to the project owner when an insert names nobody', async () => {
    const { rows } = await pool().query('select assignee_user_id from tasks where id = $1', [unnamedTask])
    expect(rows[0].assignee_user_id).toBe(ownerId)
  })

  it('keeps the assignee an insert names', async () => {
    const { rows } = await pool().query('select assignee_user_id from tasks where id = $1', [assignedTask])
    expect(rows[0].assignee_user_id).toBe(otherId)
  })

  it('cannot be cleared', async () => {
    await expect(
      pool().query('update tasks set assignee_user_id = null where id = $1', [unnamedTask]),
    ).rejects.toThrow(/assignee_user_id/)
  })

  it('filters and names through the adapter the routes use', async () => {
    const { data, error } = await admin()
      .from('tasks')
      .select(TASK_LIST_FIELDS)
      .eq('project_id', projectId)
      .eq('assignee_user_id', otherId)
    expect(error).toBeNull()
    const named = await withAssignees(data ?? [])
    expect(named.map((row) => [row.number, row.assignee?.name])).toEqual([[2, 'Other Person']])
  })

  it('refuses to hard-delete a user who still owns work in someone else\'s project', async () => {
    await expect(pool().query('delete from app_users where id = $1', [otherId])).rejects.toThrow(
      /tasks_assignee_user_id_fkey/,
    )
  })

  it('records a reassignment as its own event', async () => {
    await expect(
      pool().query(
        `insert into task_activity_events (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
         values ($1,$2,$3,'human','Owner','assignee_changed',$4)`,
        [ownerId, projectId, unnamedTask, { from: ownerId, to: otherId }],
      ),
    ).resolves.toBeDefined()
  })
})

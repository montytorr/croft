import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { formerKeysByProject, resolveProject } from '@/lib/api/project-keys'
import { resolveTask } from '@/lib/api/tasks'
import type { Actor } from '@/lib/api/auth'

/**
 * A key rename, against the installed SQL (CROFT-264).
 *
 * 057 edits two functions in place — `project_rename_key` and `activity_feed`
 * — by transforming what `pg_get_functiondef` returns rather than re-copying
 * an older file. Whether those edits landed, and whether the old refs still
 * resolve through the adapter's real SQL, is a question only a database can
 * answer: the unit suite mocks every one of these reads.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const OLD = `RO${suffix}`
const NEW = `RN${suffix}`
const RENAMER = 'claude-code · rename@example.test'

const actor = {
  userId: ownerId,
  actorType: 'agent',
  actorId: RENAMER,
  userDisplayName: 'Rename',
  role: 'admin',
  rateKey: `rename-${ownerId}`,
  sessionId: null,
} as unknown as Actor

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `rename-${ownerId}@example.test`,
    'not-used',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title, task_counter) values ($1,$2,$3,'Before',1)`,
    [projectId, ownerId, OLD],
  )
  // Filed a day before the rename, under the old key.
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status, created_at)
     values ($1,$2,1,'Filed before','agent',$3,'todo', now() - interval '1 day')`,
    [randomUUID(), projectId, RENAMER],
  )

  const renamed = await pool().query('select project_rename_key($1, $2, $3) as old', [projectId, NEW, RENAMER])
  expect(renamed.rows[0].old).toBe(OLD)

  // Filed after the rename: it was never OLD-2.
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status, created_at)
     values ($1,$2,2,'Filed after','agent',$3,'todo', now() + interval '1 second')`,
    [randomUUID(), projectId, RENAMER],
  )

  // What the PATCH route records beside the rename.
  await pool().query(
    `insert into task_activity_events (owner_user_id, project_id, actor_type, actor_id, event, data)
     values ($1,$2,'agent',$3,'project_key_changed', jsonb_build_object('from', $4::text, 'to', $5::text)),
            ($1,$2,'agent',$3,'project_renamed', jsonb_build_object('from', 'Before', 'to', 'After'))`,
    [ownerId, projectId, RENAMER, OLD, NEW],
  )
})

afterAll(async () => {
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('project_rename_key after 057', () => {
  it('records who retired the key and what it became', async () => {
    const { rows } = await pool().query(
      'select key, retired_by, new_key from project_former_keys where project_id = $1',
      [projectId],
    )
    expect(rows).toEqual([{ key: OLD, retired_by: RENAMER, new_key: NEW }])
  })

  it('is one function, so a two-argument call is never ambiguous', async () => {
    const { rows } = await pool().query(
      `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'project_rename_key'`,
    )
    expect(rows).toEqual([{ args: 'p_project uuid, p_new_key text, p_actor text' }])
  })

  it('keeps the shared-workspace body 047 installed', async () => {
    // The transformation must edit, not replace: 047's unscoped conflict
    // target is the thing a re-copy of 031 would have reverted.
    const { rows } = await pool().query(
      `select pg_get_functiondef('project_rename_key(uuid, text, text)'::regprocedure) as def`,
    )
    expect(rows[0].def).toMatch(/on conflict \(key\)/)
    expect(rows[0].def).not.toMatch(/owner_user_id\s*=\s*v_owner/)
  })

  it('lists the former key on the project', async () => {
    const former = (await formerKeysByProject([projectId])).get(projectId)
    expect(former).toHaveLength(1)
    expect(former?.[0]).toMatchObject({ key: OLD, retired_by: RENAMER, new_key: NEW })
  })
})

describe('resolving through the retired key', () => {
  it('finds the project and says it was renamed', async () => {
    const resolved = await resolveProject(OLD)
    expect(resolved?.project).toMatchObject({ id: projectId, key: NEW })
    expect(resolved?.renamed).toMatchObject({ key: OLD, to: NEW, by: RENAMER })
  })

  it('finds a task filed before the rename and says how', async () => {
    const resolved = await resolveTask(actor, `${OLD}-1`)
    expect(resolved.task?.title).toBe('Filed before')
    expect(resolved.requestedRef).toBe(`${OLD}-1`)
    expect(resolved.renamed).toMatchObject({ key: OLD, to: NEW })
  })

  it('says nothing for the current ref', async () => {
    const resolved = await resolveTask(actor, `${NEW}-1`)
    expect(resolved.task?.title).toBe('Filed before')
    expect(resolved.renamed).toBeNull()
  })

  it('refuses the old ref of a task filed after the rename, naming the live one', async () => {
    const resolved = await resolveTask(actor, `${OLD}-2`)
    expect(resolved.task).toBeNull()
    expect(resolved.neverIssued).toBe(`${NEW}-2`)
  })
})

describe('activity_feed after 057', () => {
  it('titles rename rows with what the project was and became', async () => {
    const { rows } = await pool().query(
      `select detail, title, project_key, ref
         from activity_feed($1, null, 50, $2, null, array['event'])
        where detail in ('project_key_changed', 'project_renamed')
        order by detail`,
      [ownerId, NEW],
    )
    expect(rows).toEqual([
      { detail: 'project_key_changed', title: `${OLD} → ${NEW}`, project_key: NEW, ref: NEW },
      { detail: 'project_renamed', title: 'Before → After', project_key: NEW, ref: NEW },
    ])
  })

  it('kept the shared-workspace edits 048 made', async () => {
    const { rows } = await pool().query(
      `select pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'activity_feed'`,
    )
    expect(rows[0].def).not.toMatch(/\w+\.owner_user_id\s*=\s*p_owner/i)
    expect(rows[0].def).toContain('git_commit')
  })
})

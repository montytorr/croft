import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import type { Actor } from '@/lib/api/auth'
import { untouchedCheckpoint } from '@/lib/liveness-fixtures'
import { reconcileClaims } from '@/lib/api/reconcile'

/**
 * CROFT-283 and CROFT-284, against a real database, because every failure
 * here was invisible from the application: a checkpoint overwritten reads like
 * a checkpoint, an updated_at bumped by a trigger reads like an edit, and a
 * reaper that selects nothing logs `#0` and exits 0.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const KEY = `R${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`
const ME = 'claude-code · reaper@example.test'
const SESSION = 'session-this'
const WEEK = 7 * 24 * 3_600

const agent = (agentName: string, sessionId: string | null = null): Actor => ({
  userId: ownerId,
  actorType: 'agent',
  actorId: `${agentName} · reaper@example.test`,
  userDisplayName: 'reaper@example.test',
  role: 'admin',
  rateKey: `key:${agentName}`,
  sessionId,
  agentName,
})

let number = 0
const insertTask = async (fields: {
  status?: string
  claimedBy?: string | null
  claimedSession?: string | null
  checkpoint?: string | null
  /** How long ago everything on the row happened. */
  agoSeconds?: number
  /** When the checkpoint was written, if not with everything else. */
  checkpointAgoSeconds?: number
}) => {
  const id = randomUUID()
  number += 1
  const holder = fields.claimedBy === undefined ? ME : fields.claimedBy
  // An insert, not an update: tasks_touch fires only on update, so this is
  // the one way to plant a genuinely old updated_at. Computed in SQL, so the
  // values carry the microseconds now() writes — a JS Date would round them
  // away and hide the precision bug reconcile_task_atomic had.
  await pool().query(
    `with t as (select now() - make_interval(secs => $8) as at,
                       now() - make_interval(secs => $10) as checkpoint_at)
     insert into tasks (id, project_id, number, title, status, type, actor_type, actor_id,
                        claimed_by, claimed_session, claimed_at, heartbeat_at,
                        checkpoint_summary, checkpoint_at, created_at, updated_at)
     select $1,$2,$3,$4,$5,'chore','agent',$11,$6::text,$7,
            case when $6::text is null then null else t.at end,
            case when $6::text is null then null else t.at end,
            $9::text, case when $9::text is null then null else t.checkpoint_at end, t.at, t.at
       from t`,
    [id, projectId, number, `task ${number}`, fields.status ?? 'doing', holder,
     fields.claimedSession ?? null, fields.agoSeconds ?? WEEK, fields.checkpoint ?? null,
     fields.checkpointAgoSeconds ?? fields.agoSeconds ?? WEEK, ME],
  )
  return { id, ref: `${KEY}-${number}` }
}

const row = async (id: string) =>
  (await pool().query(
    `select status, claimed_by, claimed_session, checkpoint_summary, checkpoint_version::int,
            updated_at, checkpoint_at from tasks where id = $1`,
    [id],
  )).rows[0]

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId, `reaper-${ownerId}@example.test`, 'not-used',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title) values ($1,$2,$3,'Reaper')`,
    [projectId, ownerId, KEY],
  )
})

afterAll(async () => {
  await pool().query('delete from task_activity_events where project_id = $1', [projectId])
  await pool().query('delete from tasks where project_id = $1', [projectId])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('releases (CROFT-284)', () => {
  it('manual release moves a held doing task to todo and forgets the session', async () => {
    const task = await insertTask({ claimedSession: SESSION })
    const version = (await pool().query('select ownership_version from tasks where id = $1', [task.id]))
      .rows[0].ownership_version
    const released = await pool().query(
      `select release_task_atomic($1,$2,'agent',$3,$4,$3) as row`,
      [task.id, ownerId, ME, version],
    )
    expect(released.rows[0].row).toMatchObject({ status: 'todo', claimed_by: null, claimed_session: null })
    const event = await pool().query(
      `select data->>'reopened' as reopened from task_activity_events where task_id = $1 and event = 'released'`,
      [task.id],
    )
    expect(event.rows).toEqual([{ reopened: 'true' }])
  })

  it('manual release leaves in-review, and an unheld doing task, as they were', async () => {
    const review = await insertTask({ status: 'in-review' })
    const person = await insertTask({ claimedBy: null })
    for (const task of [review, person]) {
      const version = (await pool().query('select ownership_version from tasks where id = $1', [task.id]))
        .rows[0].ownership_version
      await pool().query(`select release_task_atomic($1,$2,'human','Monty',$3,null)`, [task.id, ownerId, version])
    }
    expect((await row(review.id)).status).toBe('in-review')
    expect((await row(person.id)).status).toBe('doing')
  })

  it('the maintenance sweep releases every quiet claim in the workspace', async () => {
    const doing = await insertTask({ claimedBy: 'openclaw · reaper@example.test', claimedSession: 'oc-1' })
    const review = await insertTask({ status: 'in-review', claimedSession: 'cc-1' })
    // What a session-end sweep every 30 minutes used to leave behind: a fresh
    // "still held" checkpoint on a claim nobody has touched in a week.
    const stillHeld = await insertTask({ checkpoint: untouchedCheckpoint([]), checkpointAgoSeconds: 60 })
    const live = await insertTask({ agoSeconds: 60 })

    // An ordinary agent sees only its own.
    const own = await reconcileClaims(agent('codex'), { dryRun: true })
    expect(own.released.map((r) => r.ref)).not.toContain(doing.ref)

    const swept = await reconcileClaims(agent('maintenance'))
    const refs = swept.released.map((r) => r.ref)
    expect(swept.scope).toBe('workspace')
    expect(refs).toEqual(expect.arrayContaining([doing.ref, review.ref, stillHeld.ref]))
    expect(refs).not.toContain(live.ref)

    expect(await row(doing.id)).toMatchObject({ status: 'todo', claimed_by: null, claimed_session: null })
    expect(await row(review.id)).toMatchObject({ status: 'in-review', claimed_by: null, claimed_session: null })
    expect((await row(live.id)).claimed_by).toBe(ME)

    const events = await pool().query(
      `select actor_id, data->>'previousHolder' as holder from task_activity_events
        where task_id = $1 and event = 'released' and data->>'reason' = 'reconcile'`,
      [doing.id],
    )
    expect(events.rows).toEqual([
      { actor_id: 'maintenance · reaper@example.test', holder: 'openclaw · reaper@example.test' },
    ])
  })
})

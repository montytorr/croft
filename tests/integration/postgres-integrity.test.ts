import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const memberId = randomUUID()
const projectId = randomUUID()
const taskId = randomUUID()
const sharedTaskId = randomUUID()

beforeAll(async () => {
  await pool().query(
    `insert into app_users (id, email, encrypted_password) values ($1,$2,$3)`,
    [ownerId, `integrity-${ownerId}@example.test`, 'not-used'],
  )
  await pool().query(
    `insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,'member')`,
    [memberId, `integrity-${memberId}@example.test`, 'not-used'],
  )
  await pool().query(
    `insert into projects (id, owner_user_id, key, title) values ($1,$2,'INT','Integrity')`,
    [projectId, ownerId],
  )
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status)
     values ($1,$2,1,'Concurrency target','agent','integration-agent','todo')`,
    [taskId, projectId],
  )
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status)
     values ($1,$2,2,'Shared workspace target','agent','ClawClaw · Owner','todo')`,
    [sharedTaskId, projectId],
  )
})

afterAll(async () => {
  await pool().query('delete from app_users where id in ($1, $2)', [ownerId, memberId])
  await pool().end()
})

describe('shared workspace task lifecycle', () => {
  it('lets a member operate an existing admin-owned task with qualified attribution', async () => {
    const actor = 'Codex · Member'
    const claimed = await pool().query(
      `select claim_task_atomic($1,$2,'agent',$3,$3,$4,true) as row`,
      [sharedTaskId, memberId, actor, new Date(Date.now() - 60_000)],
    )
    expect(claimed.rows[0].row).toMatchObject({ claimed_by: actor, status: 'doing' })

    const ownershipVersion = Number(claimed.rows[0].row.ownership_version)
    const checkpointed = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent',$3,'member checkpoint',null,$4,$5,$6,0) as row`,
      [sharedTaskId, memberId, actor, randomUUID(), new Date(), ownershipVersion],
    )
    expect(checkpointed.rows[0].row).toMatchObject({ code: 'ok' })

    const released = await pool().query(
      `select release_task_atomic($1,$2,'agent',$3,$4,$3) as row`,
      [sharedTaskId, memberId, actor, ownershipVersion],
    )
    expect(released.rows[0].row.claimed_by).toBeNull()

    const events = await pool().query(
      `select distinct owner_user_id, actor_id
         from task_activity_events
        where task_id = $1 and actor_id = $2`,
      [sharedTaskId, actor],
    )
    expect(events.rows).toEqual([{ owner_user_id: memberId, actor_id: actor }])
  })

  it('keeps workspace identifiers globally unique across users', async () => {
    await expect(pool().query(
      `insert into projects (owner_user_id, key, title) values ($1, 'INT', 'Duplicate')`,
      [memberId],
    )).rejects.toMatchObject({ code: '23505' })
  })
})

describe('shared workspace RPCs', () => {
  it('returns workspace data regardless of the caller legacy owner id', async () => {
    await pool().query("update tasks set labels = array['shared-label'] where id = $1", [taskId])

    const searched = await pool().query(
      `select * from search_all($1, 'Concurrency target', null, null, null, 20, 3)`,
      [memberId],
    )
    expect(searched.rows.some((row) => row.id === taskId)).toBe(true)

    const labels = await pool().query(`select * from list_labels($1)`, [memberId])
    expect(labels.rows).toContainEqual({ label: 'shared-label', task_count: '1' })

    const activity = await pool().query(
      `select * from activity_feed($1, null, 100, null, null, null)`,
      [memberId],
    )
    expect(activity.rows.some((row) => row.actor === 'Codex · Member')).toBe(true)
  })

  it('removes owner predicates from every compatibility RPC definition', async () => {
    const names = [
      'search_all',
      'activity_feed',
      'list_labels',
      'rename_label',
      'croft_pulse',
    ]
    const definitions = await pool().query<{ proname: string; definition: string }>(
      `select p.proname, pg_get_functiondef(p.oid) as definition
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])`,
      [names],
    )
    expect(definitions.rows).toHaveLength(names.length)
    for (const row of definitions.rows) {
      expect(row.definition, row.proname).not.toMatch(/\w+\.owner_user_id\s*=\s*p_owner/i)
    }
  })
})

describe('ownership generations and checkpoint ordering', () => {
  it('prevents a stale owner generation from releasing or checkpointing a reclaimed task', async () => {
    const first = await pool().query(
      `select claim_task_atomic($1,$2,'agent','integration-agent','integration-agent',$3,true) as row`,
      [taskId, ownerId, new Date(Date.now() - 60_000)],
    )
    const version1 = Number(first.rows[0].row.ownership_version)
    expect(version1).toBe(1)

    const released = await pool().query(
      `select release_task_atomic($1,$2,'agent','integration-agent',$3,'integration-agent') as row`,
      [taskId, ownerId, version1],
    )
    expect(released.rows[0].row.claimed_by).toBeNull()

    const second = await pool().query(
      `select claim_task_atomic($1,$2,'agent','integration-agent','integration-agent',$3,true) as row`,
      [taskId, ownerId, new Date(Date.now() - 60_000)],
    )
    const version2 = Number(second.rows[0].row.ownership_version)
    expect(version2).toBe(2)

    const staleRelease = await pool().query(
      `select release_task_atomic($1,$2,'agent','integration-agent',$3,'integration-agent') as row`,
      [taskId, ownerId, version1],
    )
    expect(staleRelease.rows[0].row).toBeNull()

    const staleCheckpoint = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'stale', randomUUID(), new Date(), version1, 0],
    )
    expect(staleCheckpoint.rows[0].row.code).toBe('ownership_changed')

    const acceptedAt = new Date()
    const mutationId = randomUUID()
    const accepted = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'current', mutationId, acceptedAt, version2, 0],
    )
    expect(accepted.rows[0].row.code).toBe('ok')
    const duplicate = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'current', mutationId, acceptedAt, version2, 0],
    )
    expect(duplicate.rows[0].row.code).toBe('duplicate')

    const outOfOrder = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'out of sequence', randomUUID(), new Date(acceptedAt.getTime() + 1_000), version2, 0],
    )
    expect(outOfOrder.rows[0].row.code).toBe('checkpoint_changed')
    const nextInSequence = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,$6,$7) as row`,
      [taskId, ownerId, 'next despite skewed clock', randomUUID(), new Date(acceptedAt.getTime() - 60_000), version2, 1],
    )
    expect(nextInSequence.rows[0].row.code).toBe('ok')
    const missingPredecessor = await pool().query(
      `select checkpoint_task_atomic($1,$2,'agent','integration-agent',$3,null,$4,$5,null,null) as row`,
      [taskId, ownerId, 'missing predecessor', randomUUID(), new Date()],
    )
    expect(missingPredecessor.rows[0].row.code).toBe('missing_predecessor')
    const current = await pool().query('select checkpoint_summary, claimed_by from tasks where id = $1', [taskId])
    expect(current.rows[0]).toMatchObject({ checkpoint_summary: 'next despite skewed clock', claimed_by: 'integration-agent' })
  })

  it('makes reconcile lose safely when heartbeat state changes after its snapshot', async () => {
    const before = await pool().query(
      'select ownership_version, heartbeat_at, updated_at from tasks where id = $1', [taskId],
    )
    await pool().query('update tasks set heartbeat_at = now() + interval \'1 second\' where id = $1', [taskId])
    const result = await pool().query(
      `select reconcile_task_atomic($1,$2,'agent','integration-agent','integration-agent',$3,$4,$5,true,'stale','stale-hash') as released`,
      [taskId, ownerId, before.rows[0].ownership_version, before.rows[0].heartbeat_at, before.rows[0].updated_at],
    )
    expect(result.rows[0].released).toBe(false)
  })
})

describe('N-1 migration compatibility', () => {
  it('upgrades an existing pre-043 database without breaking old writes', async () => {
    const adminUrl = new URL(databaseUrl)
    const dbName = `croft_n1_${randomUUID().replaceAll('-', '')}`
    const admin = new Client({ connectionString: adminUrl.toString() })
    await admin.connect()
    await admin.query(`create database "${dbName}"`)
    const testUrl = new URL(databaseUrl)
    testUrl.pathname = `/${dbName}`
    const client = new Client({ connectionString: testUrl.toString() })
    await client.connect()
    try {
      const files = (await readdir(join(process.cwd(), 'migrations'))).filter((name) => name.endsWith('.sql')).sort()
      for (const file of files.filter((name) => name < '043_')) {
        await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
      }
      const user = randomUUID()
      const project = randomUUID()
      const task = randomUUID()
      await client.query('insert into app_users (id,email,encrypted_password) values ($1,$2,$3)', [user, `${user}@test`, 'x'])
      await client.query("insert into projects (id,owner_user_id,key,title) values ($1,$2,'OLD','Old')", [project, user])
      await client.query("insert into tasks (id,project_id,number,title,actor_type,actor_id) values ($1,$2,1,'Old row','agent','old-cli')", [task, project])

      await client.query(await readFile(join(process.cwd(), 'migrations', '043_integrity_boundaries.sql'), 'utf8'))
      const upgraded = await client.query('select ownership_version, checkpoint_version from tasks where id = $1', [task])
      expect(upgraded.rows[0]).toMatchObject({ ownership_version: '0', checkpoint_version: '0' })

      await client.query("update tasks set heartbeat_at = now() where id = $1", [task])
      await client.query("insert into task_comments (task_id,actor_type,actor_id,content) values ($1,'agent','old-cli','still works')", [task])
      expect((await client.query('select count(*)::int as count from task_comments where task_id = $1', [task])).rows[0].count).toBe(1)
    } finally {
      await client.end()
      await admin.query(`drop database "${dbName}"`)
      await admin.end()
    }
  })

  it('preserves legacy identities and qualifies every historical attribution surface', async () => {
    const adminUrl = new URL(databaseUrl)
    const dbName = `croft_users_${randomUUID().replaceAll('-', '')}`
    const admin = new Client({ connectionString: adminUrl.toString() })
    await admin.connect()
    await admin.query(`create database "${dbName}"`)
    const testUrl = new URL(databaseUrl)
    testUrl.pathname = `/${dbName}`
    const client = new Client({ connectionString: testUrl.toString() })
    await client.connect()
    try {
      const files = (await readdir(join(process.cwd(), 'migrations'))).filter((name) => name.endsWith('.sql')).sort()
      for (const file of files.filter((name) => name < '046_')) {
        await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
      }
      const user = randomUUID()
      const key = randomUUID()
      const session = randomUUID()
      const project = randomUUID()
      const task = randomUUID()
      const note = randomUUID()
      const comment = randomUUID()
      const attachment = randomUUID()
      const activity = randomUUID()
      const knowledge = randomUUID()
      const search = randomUUID()
      await client.query(
        'insert into app_users (id,email,encrypted_password) values ($1,$2,$3)',
        [user, `${user}@test`, 'x'],
      )
      await client.query(
        `insert into api_keys (id,user_id,agent_name,name,key_prefix,key_hash)
         values ($1,$2,'clawclaw','ClawClaw','sk_live_','legacy-hash')`,
        [key, user],
      )
      await client.query(
        `insert into app_sessions (id,user_id,token_hash,expires_at)
         values ($1,$2,'legacy-session',now() + interval '1 day')`,
        [session, user],
      )
      await client.query(
        'insert into user_profiles (id,display_name) values ($1,$2)',
        [user, 'Julien'],
      )
      await client.query(
        `insert into projects (id,owner_user_id,key,title) values ($1,$2,'LEG','Legacy')`,
        [project, user],
      )
      await client.query(
        `insert into tasks
           (id,project_id,number,title,status,actor_type,actor_id,claimed_by,resolution,resolution_kind,resolved_by)
         values ($1,$2,1,'Legacy task','done','agent','clawclaw','clawclaw','done','fixed','clawclaw')`,
        [task, project],
      )
      await client.query(
        `insert into task_notes (id,task_id,actor_type,actor_id,note)
         values ($1,$2,'agent','clawclaw','legacy note')`,
        [note, task],
      )
      await client.query(
        `insert into task_comments (id,task_id,actor_type,actor_id,content)
         values ($1,$2,'human',$3,'legacy comment')`,
        [comment, task, user],
      )
      await client.query(
        `insert into task_attachments
           (id,task_id,actor_type,actor_id,filename,original_name,mime_type,size_bytes,storage_path)
         values ($1,$2,'agent','clawclaw','legacy.txt','legacy.txt','text/plain',1,$3)`,
        [attachment, task, `legacy/${attachment}`],
      )
      await client.query(
        `insert into task_activity_events (id,task_id,owner_user_id,actor_type,actor_id,event)
         values ($1,$2,null,'agent','clawclaw','created')`,
        [activity, task],
      )
      await client.query(
        `insert into knowledge (id,owner_user_id,slug,title,actor_type,actor_id)
         values ($1,$2,'legacy-fact','Legacy fact','agent','clawclaw')`,
        [knowledge, user],
      )
      await client.query(
        `insert into sessions (id,owner_user_id,external_id,platform_source,agent_id)
         values ($1,$2,'legacy-run','codex','clawclaw')`,
        [session, user],
      )
      await client.query(
        `insert into search_events (id,owner_user_id,actor_id,query,result_count)
         values ($1,$2,'clawclaw','legacy query',1)`,
        [search, user],
      )

      // Up to the last migration that still had the memory tables, so their
      // attribution is checked before 072 drops them.
      for (const file of files.filter((name) => name >= '046_' && name < '072_')) {
        await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
      }

      expect((await client.query('select id, role from app_users where id = $1', [user])).rows[0])
        .toEqual({ id: user, role: 'admin' })
      expect((await client.query('select id, user_id, auth_epoch::text from api_keys where id = $1', [key])).rows[0])
        .toEqual({ id: key, user_id: user, auth_epoch: '0' })
      expect((await client.query('select id, user_id, session_epoch::text from app_sessions where id = $1', [session])).rows[0])
        .toEqual({ id: session, user_id: user, session_epoch: '0' })

      const agent = 'clawclaw · Julien'
      expect((await client.query(
        'select actor_id, claimed_by, resolved_by from tasks where id = $1',
        [task],
      )).rows[0]).toEqual({ actor_id: agent, claimed_by: agent, resolved_by: agent })
      expect((await client.query('select actor_id from task_notes where id = $1', [note])).rows[0].actor_id)
        .toBe(agent)
      expect((await client.query('select actor_id from task_comments where id = $1', [comment])).rows[0].actor_id)
        .toBe('Julien')
      expect((await client.query('select actor_id from task_attachments where id = $1', [attachment])).rows[0].actor_id)
        .toBe(agent)
      expect((await client.query(
        'select actor_id, owner_user_id from task_activity_events where id = $1',
        [activity],
      )).rows[0]).toEqual({ actor_id: agent, owner_user_id: user })
      expect((await client.query('select actor_id from knowledge where id = $1', [knowledge])).rows[0].actor_id)
        .toBe(agent)
      expect((await client.query('select agent_id from sessions where external_id = $1', ['legacy-run'])).rows[0].agent_id)
        .toBe(agent)
      expect((await client.query('select actor_id from search_events where id = $1', [search])).rows[0].actor_id)
        .toBe(agent)

      // 072 drops the memory stores on a database that holds rows in them, and
      // what the lab still reads survives it.
      for (const file of files.filter((name) => name >= '072_')) {
        await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
      }
      const left = await client.query<{ name: string }>(
        `select table_name as name from information_schema.tables
          where table_schema = 'public'
            and table_name in ('knowledge', 'sessions', 'search_events', 'entities', 'file_touches')`,
      )
      expect(left.rows).toEqual([])
      expect((await client.query('select actor_id from task_notes where id = $1', [note])).rows[0].actor_id)
        .toBe(agent)
      expect((await client.query(`select count(*)::int as n from activity_feed($1, null, 50, null, null, null)`, [user]))
        .rows[0].n).toBeGreaterThan(0)
      expect((await client.query(`select croft_pulse(null) as p`)).rows[0].p).toEqual(expect.any(String))

      const member = randomUUID()
      await client.query(
        'insert into app_users (id,email,encrypted_password) values ($1,$2,$3)',
        [member, `${member}@test`, 'x'],
      )
      expect((await client.query('select role from app_users where id = $1', [member])).rows[0].role)
        .toBe('member')
      await expect(client.query("update app_users set role = 'owner' where id = $1", [member]))
        .rejects.toMatchObject({ code: '23514' })
    } finally {
      await client.end()
      await admin.query(`drop database "${dbName}"`)
      await admin.end()
    }
  })
})

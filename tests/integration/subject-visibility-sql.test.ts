import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'

/**
 * Migration 076 at the SQL level: the visibility rule itself, and the read
 * RPCs that filter through it. The routes and the TypeScript read paths are
 * covered by subject-visibility.test.ts; this file pins what the database
 * promises on its own, because every one of those paths leans on it.
 *
 * A (owner), B (member of the members subject), C (outsider), D (admin, who
 * sees no more than C: there is no administrator exception since 077).
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const RUN = randomUUID().replace(/[^a-z]/g, '').slice(0, 6)
const WORD = `narwhal${RUN}kestrel`
const KEY = `V${RUN.toUpperCase().slice(0, 5)}`
const LABEL = `hush-${RUN}`

const users = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), e: randomUUID() }
const projectId = randomUUID()
const subjects = { priv: randomUUID(), members: randomUUID(), lab: randomUUID() }
const tasks = { priv: randomUUID(), members: randomUUID(), lab: randomUUID(), plain: randomUUID(), doomed: randomUUID() }
const ids = { privNote: randomUUID(), privComment: randomUUID() }

const HIDDEN_FROM_C = [subjects.priv, subjects.members, tasks.priv, tasks.members, ids.privNote]

const q = (sql: string, params: unknown[] = []) => pool().query(sql, params)

const addSubject = async (id: string, visibility: string, title: string, owner: string | null = users.a) =>
  q(
    `insert into subjects (id, title, body, stage_id, owner_user_id, visibility, actor_type, actor_id)
     values ($1, $2, $3, (select id from subject_stages order by position limit 1), $4, $5, 'human', 'visibility-sql')`,
    [id, title, `${WORD} body`, owner, visibility],
  )

const addTask = async (id: string, number: number, title: string, subjectId: string | null, labels: string[] = []) =>
  q(
    `insert into tasks (id, project_id, number, title, description, actor_type, actor_id, status, subject_id, labels, assignee_user_id)
     values ($1, $2, $3, $4, $5, 'agent', 'visibility-sql', 'todo', $6, $7, $8)`,
    [id, projectId, number, title, `about ${WORD}`, subjectId, labels, users.a],
  )

const visible = async (subject: string, viewer: string | null) =>
  (await q('select croft_subject_visible($1, $2) as v', [subject, viewer])).rows[0].v as boolean

const pulse = async (viewer: string) =>
  (await q('select croft_pulse($1, null) as p', [viewer])).rows[0].p as string

beforeAll(async () => {
  for (const [name, id] of Object.entries(users)) {
    await q(`insert into app_users (id, email, encrypted_password, role) values ($1, $2, 'not-used', $3)`, [
      id,
      `visibility-sql-${name}-${id}@example.test`,
      name === 'd' ? 'admin' : 'member',
    ])
  }
  await q(`insert into projects (id, owner_user_id, key, title) values ($1, $2, $3, 'Visibility SQL')`, [
    projectId,
    users.a,
    KEY,
  ])

  await addSubject(subjects.priv, 'private', `Private ${WORD} ${WORD} ${WORD}`)
  await addSubject(subjects.members, 'members', `Members ${WORD}`)
  await addSubject(subjects.lab, 'lab', `Lab ${WORD}`)
  await q('insert into subject_members (subject_id, user_id, added_by) values ($1, $2, $3)', [
    subjects.members,
    users.b,
    users.a,
  ])

  // The private todo outranks the lab one on purpose: a filter applied after
  // the limit would leave an outsider with nothing at p_limit = 1.
  await addTask(tasks.priv, 1, `${WORD} ${WORD} ${WORD} private todo`, subjects.priv, [LABEL])
  await addTask(tasks.members, 2, `${WORD} members todo`, subjects.members)
  await addTask(tasks.lab, 3, `${WORD} lab todo`, subjects.lab)
  await addTask(tasks.plain, 4, 'A task with no subject', null)
  await addTask(tasks.doomed, 5, `${WORD} doomed private todo`, subjects.priv)

  await q(
    `insert into task_notes (id, task_id, actor_type, actor_id, note, kind)
     values ($1, $2, 'agent', 'visibility-sql', $3, 'finding')`,
    [ids.privNote, tasks.priv, `${WORD} finding on the private todo`],
  )
  await q(
    `insert into task_comments (id, task_id, actor_type, actor_id, content)
     values ($1, $2, 'human', 'visibility-sql', $3)`,
    [ids.privComment, tasks.priv, `${WORD} comment on the private todo`],
  )
  await q(
    `insert into task_activity_events (task_id, project_id, owner_user_id, actor_type, actor_id, event)
     values ($1, $2, $3, 'agent', 'visibility-sql', 'status_changed')`,
    [tasks.priv, projectId, users.a],
  )
  // A tombstone, written before the delete exactly as the route writes it.
  await q(
    `insert into task_activity_events (task_id, project_id, owner_user_id, actor_type, actor_id, event, data)
     values ($1, $2, $3, 'agent', 'visibility-sql', 'task_deleted', $4)`,
    [tasks.doomed, projectId, users.a, { ref: `${KEY}-5`, title: `${WORD} doomed private todo` }],
  )
  await q('delete from tasks where id = $1', [tasks.doomed])
})

afterAll(async () => {
  await q('delete from projects where id = $1', [projectId])
  await q('delete from task_activity_events where project_id is null and actor_id = $1', ['visibility-sql'])
  await q('delete from subjects where id = any($1::uuid[])', [Object.values(subjects)])
  await q('delete from app_users where id = any($1::uuid[])', [Object.values(users)])
  await pool().end()
})

describe('croft_subject_visible', () => {
  it('shows a lab subject to everyone, and a private one to its owner alone', async () => {
    for (const viewer of [users.a, users.b, users.c, users.d, null]) {
      expect(await visible(subjects.lab, viewer)).toBe(true)
    }
    expect(await visible(subjects.priv, users.a)).toBe(true)
    for (const viewer of [users.b, users.c, users.d, null]) {
      expect(await visible(subjects.priv, viewer), String(viewer)).toBe(false)
    }
  })

  it('shows a members subject to its owner and members only', async () => {
    expect(await visible(subjects.members, users.a)).toBe(true)
    expect(await visible(subjects.members, users.b)).toBe(true)
    expect(await visible(subjects.members, users.c)).toBe(false)
    expect(await visible(subjects.members, users.d)).toBe(false)
  })

  it('does not treat membership of a private subject as access', async () => {
    await q('insert into subject_members (subject_id, user_id) values ($1, $2)', [subjects.priv, users.b])
    try {
      expect(await visible(subjects.priv, users.b)).toBe(false)
    } finally {
      await q('delete from subject_members where subject_id = $1 and user_id = $2', [subjects.priv, users.b])
    }
  })

  it('has no administrator exception: an owner gone hides a private subject from everyone', async () => {
    // 077 removed it. Disabling the owner used to let an active admin in.
    await q('update app_users set deleted_at = now() where id = $1', [users.a])
    try {
      expect(await visible(subjects.priv, users.d), 'an active admin').toBe(false)
      expect(await visible(subjects.members, users.d), 'an active admin, members subject').toBe(false)
      expect(await visible(subjects.priv, users.c)).toBe(false)
      expect(await visible(subjects.members, users.b), 'a member still sees a members subject').toBe(true)
      expect(await visible(subjects.lab, users.d)).toBe(true)
    } finally {
      await q('update app_users set deleted_at = null where id = $1', [users.a])
    }

    await q(`update app_users set banned_until = now() + interval '1 day' where id = $1`, [users.a])
    try {
      expect(await visible(subjects.priv, users.d), 'a banned owner changes nothing either').toBe(false)
    } finally {
      await q('update app_users set banned_until = null where id = $1', [users.a])
    }
    expect(await visible(subjects.priv, users.a), 'restored, the owner sees it again').toBe(true)
  })

  it('installs a rule that no longer mentions administrators', async () => {
    const { rows } = await q(`select pg_get_functiondef('croft_subject_visible(uuid, uuid)'::regprocedure) as def`)
    expect(rows[0].def).not.toMatch(/'admin'|croft_user_active|app_users/)
    expect(rows[0].def).toMatch(/SECURITY DEFINER/)
    // croft_user_active stays: other code still asks whether someone is active.
    expect((await q('select croft_user_active($1) as active', [users.a])).rows[0].active).toBe(true)
  })

  it('answers false for a subject that does not exist, and true for a task with none', async () => {
    expect(await visible(randomUUID(), users.a)).toBe(false)
    const { rows } = await q('select croft_task_visible(null, $1) as none, croft_task_visible($2, $1) as priv', [
      users.c,
      subjects.priv,
    ])
    expect(rows[0]).toEqual({ none: true, priv: false })
  })

  it('lists exactly the subjects a viewer can see', async () => {
    const mine = async (viewer: string) =>
      new Set(
        (await q('select croft_visible_subjects($1) as id', [viewer])).rows
          .map((r) => r.id as string)
          .filter((id) => (Object.values(subjects) as string[]).includes(id)),
      )
    expect(await mine(users.a)).toEqual(new Set(Object.values(subjects)))
    expect(await mine(users.b)).toEqual(new Set([subjects.members, subjects.lab]))
    expect(await mine(users.c)).toEqual(new Set([subjects.lab]))
    expect(await mine(users.d)).toEqual(new Set([subjects.lab]))
  })
})

describe('schema', () => {
  it('refuses a private or members subject with no owner', async () => {
    await expect(addSubject(randomUUID(), 'private', 'Nobody owns me', null)).rejects.toThrow(/must have an owner/)
    await expect(q(`update subjects set visibility = 'members', owner_user_id = null where id = $1`, [subjects.lab]))
      .rejects.toThrow(/must have an owner/)
    await expect(q('update subjects set owner_user_id = null where id = $1', [subjects.priv]))
      .rejects.toThrow(/must have an owner/)
  })

  it('still lets a user be hard-deleted, leaving their private subject hidden from everyone', async () => {
    const orphan = randomUUID()
    await addSubject(orphan, 'private', `Orphan ${RUN}`, users.e)
    try {
      await q('delete from app_users where id = $1', [users.e])
      const { rows } = await q('select owner_user_id from subjects where id = $1', [orphan])
      expect(rows[0].owner_user_id).toBeNull()
      // Accepted in SECURITY.md: with no owner and no administrator exception,
      // nobody sees it; the database is the break-glass.
      expect(await visible(orphan, users.d)).toBe(false)
      expect(await visible(orphan, users.c)).toBe(false)
    } finally {
      await q('delete from subjects where id = $1', [orphan])
    }
  })

  it('never lets deleting a subject turn its todos into public tasks', async () => {
    await expect(q('delete from subjects where id = $1', [subjects.priv])).rejects.toMatchObject({ code: '23503' })
  })

  it('stamps activity with the task subject, so a tombstone keeps it', async () => {
    const { rows } = await q(
      `select event, subject_id from task_activity_events where project_id = $1 order by event`,
      [projectId],
    )
    expect(rows).toEqual([
      { event: 'status_changed', subject_id: subjects.priv },
      { event: 'task_deleted', subject_id: subjects.priv },
    ])
  })

  it('accepts the server-written visibility log note', async () => {
    await q(
      `insert into subject_notes (subject_id, kind, note, actor_type, actor_id)
       values ($1, 'visibility', 'made private', 'human', 'visibility-sql')`,
      [subjects.members],
    )
  })
})

describe('search_all', () => {
  const searchAll = async (viewer: string, limit = 50) =>
    (await q('select * from search_all($1, $2, null, null, null, $3, 3)', [viewer, WORD, limit])).rows

  it('leaves out private subjects, their todos and their notes for an outsider', async () => {
    const hits = new Set((await searchAll(users.c)).map((r) => r.id as string))
    expect(hits.has(subjects.lab)).toBe(true)
    expect(hits.has(tasks.lab)).toBe(true)
    for (const hidden of [subjects.priv, subjects.members, tasks.priv, tasks.members, ids.privNote]) {
      expect(hits.has(hidden), hidden).toBe(false)
    }

    const owner = new Set((await searchAll(users.a)).map((r) => r.id as string))
    for (const shown of [subjects.priv, subjects.members, tasks.priv, tasks.members, ids.privNote]) {
      expect(owner.has(shown), shown).toBe(true)
    }

    const member = new Set((await searchAll(users.b)).map((r) => r.id as string))
    expect(member.has(tasks.members)).toBe(true)
    expect(member.has(tasks.priv)).toBe(false)
  })

  it('filters before the limit, so an outsider still gets a full answer', async () => {
    const [top] = await searchAll(users.a, 1)
    expect([subjects.priv, tasks.priv]).toContain(top.id)
    const outsider = await searchAll(users.c, 1)
    expect(outsider).toHaveLength(1)
    expect(HIDDEN_FROM_C).not.toContain(outsider[0].id)
  })
})

describe('activity_feed', () => {
  const feed = async (viewer: string) =>
    (await q('select * from activity_feed($1, null, 200, $2, null, null)', [viewer, KEY])).rows as {
      kind: string
      ref: string
      title: string
      detail: string
    }[]

  it('hides every arm of a private todo, tombstone included, from an outsider', async () => {
    const outsider = await feed(users.c)
    expect(outsider.some((r) => r.title.includes(WORD) && !r.title.includes('lab todo'))).toBe(false)
    expect(outsider.some((r) => r.ref === `${KEY}-1` || r.ref === `${KEY}-5`)).toBe(false)
    expect(outsider.some((r) => r.ref === `${KEY}-3`)).toBe(true)

    const owner = await feed(users.a)
    const ownerPrivate = owner.filter((r) => r.ref === `${KEY}-1`).map((r) => r.kind).sort()
    expect(ownerPrivate).toEqual(['comment', 'event', 'note', 'task'])
    expect(owner.some((r) => r.ref === `${KEY}-5` && r.detail === 'task_deleted')).toBe(true)
  })

  it('shows it all once the subject is published', async () => {
    await q(`update subjects set visibility = 'lab' where id = $1`, [subjects.priv])
    try {
      const outsider = await feed(users.c)
      expect(outsider.some((r) => r.ref === `${KEY}-1`)).toBe(true)
      expect(outsider.some((r) => r.ref === `${KEY}-5`)).toBe(true)
    } finally {
      await q(`update subjects set visibility = 'private' where id = $1`, [subjects.priv])
    }
  })
})

describe('labels', () => {
  it('counts only visible tasks', async () => {
    const labels = async (viewer: string) =>
      (await q('select * from list_labels($1)', [viewer])).rows.filter((r) => r.label === LABEL)
    expect(await labels(users.a)).toEqual([{ label: LABEL, task_count: '1' }])
    expect(await labels(users.c)).toEqual([])
  })

  it('renames only the tasks the caller can see', async () => {
    const { rows } = await q('select rename_label($1, $2, $3) as n', [users.c, LABEL, `${LABEL}-x`])
    expect(rows[0].n).toBe(0)
    const { rows: task } = await q('select labels from tasks where id = $1', [tasks.priv])
    expect(task[0].labels).toEqual([LABEL])
  })
})

describe('croft_pulse', () => {
  it('does not move for an outsider when a private subject changes', async () => {
    const before = { a: await pulse(users.a), c: await pulse(users.c) }

    await q(`update subjects set body = body || ' more' where id = $1`, [subjects.priv])
    await q(`update tasks set title = title || ' more' where id = $1`, [tasks.priv])
    await q(
      `insert into subject_notes (subject_id, note, actor_type, actor_id) values ($1, 'hidden note', 'human', 'visibility-sql')`,
      [subjects.priv],
    )
    await q(
      `insert into subject_human_notes (subject_id, body, actor_type, actor_id) values ($1, 'hidden', 'human', 'visibility-sql')`,
      [subjects.priv],
    )
    await q(
      `insert into task_activity_events (task_id, project_id, owner_user_id, actor_type, actor_id, event)
       values ($1, $2, $3, 'agent', 'visibility-sql', 'renamed')`,
      [tasks.priv, projectId, users.a],
    )

    expect(await pulse(users.c)).toBe(before.c)
    expect(await pulse(users.a)).not.toBe(before.a)
  })

  it('moves for an outsider when a lab subject changes', async () => {
    const before = await pulse(users.c)
    await q(`update subjects set body = body || ' more' where id = $1`, [subjects.lab])
    expect(await pulse(users.c)).not.toBe(before)
  })
})

describe('installed definitions', () => {
  it('filters every read RPC through the helper, with no owner predicate', async () => {
    const { rows } = await q(
      `select p.proname, pg_get_functiondef(p.oid) as definition
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = any($1::text[])`,
      [['search_all', 'activity_feed', 'list_labels', 'rename_label', 'croft_pulse']],
    )
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row.definition, row.proname).toContain('croft_visible_subjects(p_owner)')
      expect(row.definition, row.proname).not.toMatch(/\w+\.owner_user_id\s*=\s*p_owner/i)
    }
  })
})

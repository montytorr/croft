import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Handing a todo off to another tracker, through the real route handlers and a
 * real database: link, re-link and take back; the outcome closing the todo
 * once; the tracker owning a handed-off todo's status from then on; and the
 * lab-only refusal. Also what 0.8 removed: the routes and tables are gone.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { POST as createSubjectRoute } from '@/app/api/v1/subjects/route'
import { POST as addTodoRoute } from '@/app/api/v1/subjects/[ref]/todos/route'
import { GET as listNotesRoute } from '@/app/api/v1/subjects/[ref]/notes/route'
import { GET as showTaskRoute, PATCH as patchTaskRoute } from '@/app/api/v1/tasks/[ref]/route'
import { POST as claimRoute } from '@/app/api/v1/tasks/[ref]/claim/route'
import { POST as releaseRoute } from '@/app/api/v1/tasks/[ref]/release/route'
import { POST as checkpointRoute } from '@/app/api/v1/tasks/[ref]/checkpoint/route'
import { POST as taskNoteRoute } from '@/app/api/v1/tasks/[ref]/notes/route'
import { DELETE as undoRoute, POST as handoffRoute } from '@/app/api/v1/tasks/[ref]/handoff/route'
import { POST as createProjectTaskRoute } from '@/app/api/v1/projects/[id]/tasks/route'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://croft.example.test'
const RUN = randomUUID().replace(/[^a-z]/g, '').slice(0, 6)
const userId = randomUUID()

const asAgent = () => {
  auth.actor = {
    userId,
    actorType: 'agent',
    actorId: `claude-code · handoff-${RUN}@example.test`,
    userDisplayName: 'Handoff',
    role: 'admin',
    rateKey: `handoff-${randomUUID()}`,
    sessionId: null,
    agentName: 'claude-code',
  }
}

const headers = { 'content-type': 'application/json', authorization: 'Bearer test' }
const call = async <P extends Record<string, string>>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  method: string,
  path: string,
  params: P = {} as P,
  body?: unknown,
) => {
  const response = await handler(
    new Request(`${ORIGIN}/api/v1${path}`, {
      method,
      headers: method === 'GET' ? {} : headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  )
  return { status: response.status, json: (await response.json()) as Record<string, any> }
}

const q = (sql: string, params: unknown[] = []) => pool().query(sql, params)

const subjectIds: string[] = []
let todoProjectExisted = false
let labRef = ''
let privateRef = ''

const fileSubject = async (title: string, visibility?: string) => {
  const res = await call(createSubjectRoute, 'POST', '/subjects', {}, { title, ...(visibility ? { visibility } : {}) })
  expect(res.status).toBe(201)
  subjectIds.push(res.json.data.id)
  return res.json.data.ref as string
}

const fileTodo = async (subject: string, title: string) => {
  const res = await call(addTodoRoute, 'POST', `/subjects/${subject}/todos`, { ref: subject }, { title })
  expect(res.status).toBe(201)
  return res.json.data.ref as string
}

const link = (ref: string, body: Record<string, unknown>) => call(handoffRoute, 'POST', `/tasks/${ref}/handoff`, { ref }, body)
const show = async (ref: string) => (await call(showTaskRoute, 'GET', `/tasks/${ref}`, { ref })).json.data
const notesOf = async (subject: string) => (await call(listNotesRoute, 'GET', `/subjects/${subject}/notes`, { ref: subject })).json.data as { kind: string; note: string }[]

beforeAll(async () => {
  await q('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
    userId,
    `handoff-${userId}@example.test`,
    'not-used',
    'admin',
  ])
  todoProjectExisted = (await q(`select 1 from projects where key = 'T'`)).rowCount === 1
  asAgent()
  labRef = await fileSubject(`Handoff lab ${RUN}`)
  privateRef = await fileSubject(`Handoff private ${RUN}`, 'private')
})

afterAll(async () => {
  if (subjectIds.length) {
    await q('delete from tasks where subject_id = any($1::uuid[])', [subjectIds])
    await q('delete from subjects where id = any($1::uuid[])', [subjectIds])
  }
  if (!todoProjectExisted) await q(`delete from projects where key = 'T' and owner_user_id = $1`, [userId])
  await q('delete from app_users where id = $1', [userId])
  await pool().end()
})

describe('linking, re-linking and taking back', () => {
  it('records the link, says so once on the subject, and re-linking overwrites it', async () => {
    asAgent()
    const todo = await fileTodo(labRef, 'Ship the index')
    const first = await link(todo, { tracker: 'GitHub', ref: 'owner/repo#4', url: 'https://github.com/owner/repo/issues/4', status: 'todo' })
    expect(first.status).toBe(200)
    expect(first.json.data).toMatchObject({
      ref: todo,
      handoff: { tracker: 'github', ref: 'owner/repo#4', url: 'https://github.com/owner/repo/issues/4', status: 'todo' },
      noted: false,
      closed: false,
    })

    // Reported again unchanged (what a sync does): no second note.
    await link(todo, { tracker: 'github', ref: 'owner/repo#4', status: 'doing' })
    const again = await show(todo)
    expect(again.handoff).toMatchObject({ tracker: 'github', ref: 'owner/repo#4', status: 'doing', url: 'https://github.com/owner/repo/issues/4' })

    // Re-linked elsewhere: nothing of the old link survives that was not sent.
    const moved = await link(todo, { tracker: 'linear', ref: 'LIN-5' })
    expect(moved.json.data.handoff).toEqual({ tracker: 'linear', ref: 'LIN-5', url: null, status: null, synced_at: expect.any(String) })
    expect(moved.json.data).not.toHaveProperty('cairn_ref')

    const notes = (await notesOf(labRef)).filter((n) => n.kind === 'handoff').map((n) => n.note)
    expect(notes).toContain(`${todo} handed off to github as owner/repo#4`)
    expect(notes).toContain(`${todo} handed off to linear as LIN-5`)
    expect(notes.filter((n) => n.includes('owner/repo#4'))).toHaveLength(1)

    // The raw columns never leak.
    expect(await show(todo)).not.toHaveProperty('handoff_ref')
  })

  it('takes a hand-off back: clears it, notes it, returns the todo, and a second undo is a conflict', async () => {
    asAgent()
    const todo = await fileTodo(labRef, 'Take me back')
    await link(todo, { tracker: 'github', ref: 'owner/repo#7', status: 'doing' })

    const undone = await call(undoRoute, 'DELETE', `/tasks/${todo}/handoff`, { ref: todo })
    expect(undone.status).toBe(200)
    expect(undone.json.data).toMatchObject({ handoff: null, status: 'todo' })
    expect((await q(`select handoff_tracker, handoff_ref, handoff_url, handoff_status, handoff_synced_at from tasks where id = $1`, [undone.json.data.id])).rows[0]).toEqual({
      handoff_tracker: null,
      handoff_ref: null,
      handoff_url: null,
      handoff_status: null,
      handoff_synced_at: null,
    })
    expect((await notesOf(labRef)).map((n) => n.note)).toContain(`${todo} taken back from github (owner/repo#7)`)

    const twice = await call(undoRoute, 'DELETE', `/tasks/${todo}/handoff`, { ref: todo })
    expect(twice.status).toBe(409)
    expect(twice.json.code).toBe('conflict')

    // Back in the lab's hands: it can be claimed again.
    expect((await call(claimRoute, 'POST', `/tasks/${todo}/claim`, { ref: todo }, {})).status).toBe(200)
  })

  it('refuses a malformed tracker, ref or url, and an unknown todo', async () => {
    asAgent()
    const todo = await fileTodo(labRef, 'Validate me')
    for (const bad of [
      { tracker: 'x', ref: 'A-1' },
      { tracker: 'has space', ref: 'A-1' },
      { tracker: 'github', ref: 'two words' },
      { tracker: 'github', ref: '' },
      { tracker: 'github', ref: 'A-1', url: 'ftp://example.test/1' },
    ]) {
      const refused = await link(todo, bad)
      expect([JSON.stringify(bad), refused.status]).toEqual([JSON.stringify(bad), 400])
    }
    expect((await link('T-999999', { tracker: 'github', ref: 'A-1' })).status).toBe(404)
  })
})

describe('the outcome', () => {
  it('closes the todo once, as verified when Croft lacks the tracker\'s kind, and notes it once', async () => {
    asAgent()
    const todo = await fileTodo(labRef, 'Wire the flag')
    await link(todo, { tracker: 'github', ref: 'owner/repo#11', status: 'doing' })

    const body = { tracker: 'github', ref: 'owner/repo#11', status: 'done', resolution: 'Shipped.', resolutionKind: 'shipped-in-v2' }
    const first = await link(todo, body)
    expect(first.json.data).toMatchObject({ status: 'done', noted: true, closed: true })
    const second = await link(todo, { ...body, resolution: 'Reworded later.' })
    expect(second.json.data).toMatchObject({ status: 'done', noted: false, closed: false })

    expect(await show(todo)).toMatchObject({
      status: 'done',
      resolution: 'Closed in github as owner/repo#11: Shipped.',
      resolution_kind: 'verified',
      handoff: { status: 'done' },
    })
    const outcome = (await notesOf(labRef)).filter((n) => n.note.startsWith('owner/repo#11 done'))
    expect(outcome).toEqual([expect.objectContaining({ kind: 'finding', note: 'owner/repo#11 done: Shipped.' })])
    const resolved = await q(`select count(*)::int as n from task_activity_events e join tasks t on t.id = e.task_id where e.event = 'resolved' and t.subject_id = (select id from subjects where number = $1)`, [Number(labRef.slice(2))])
    expect(resolved.rows[0].n).toBeGreaterThanOrEqual(1)
  })

  it('keeps a Croft resolution kind, and lets the ordinary routes work again once it has ended', async () => {
    asAgent()
    const todo = await fileTodo(labRef, 'Superseded')
    await link(todo, { tracker: 'github', ref: 'owner/repo#12' })
    await link(todo, { tracker: 'github', ref: 'owner/repo#12', status: 'cancelled', resolution: 'Superseded.', resolutionKind: 'superseded' })
    expect(await show(todo)).toMatchObject({ status: 'cancelled', resolution_kind: 'superseded' })

    // The hand-off has ended, so the tracker no longer owns the status.
    const reopened = await call(patchTaskRoute, 'PATCH', `/tasks/${todo}`, { ref: todo }, { status: 'todo' })
    expect(reopened.status).toBe(200)
  })
})

describe('a subject that is not in the lab', () => {
  it('is refused without force, with a message that names the tracker, and records nothing', async () => {
    asAgent()
    const todo = await fileTodo(privateRef, 'Private work')
    const refused = await link(todo, { tracker: 'github', ref: 'owner/repo#20' })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ code: 'subject_not_published', subject: privateRef, visibility: 'private' })
    expect(refused.json.error).toContain('github has no notion of who may see what')
    expect(refused.json.error).not.toMatch(/cairn/i)
    expect((await show(todo)).handoff).toBeNull()

    const forced = await link(todo, { tracker: 'github', ref: 'owner/repo#20', force: true })
    expect(forced.status).toBe(200)
    expect(forced.json.data.handoff).toMatchObject({ tracker: 'github', ref: 'owner/repo#20' })
  })
})

describe('a handed-off todo belongs to its tracker', () => {
  let todo = ''
  const message = (ref: string) =>
    `${ref} was handed off to github as owner/repo#30, which owns its status now: work it there ` +
    `(croft sync brings the outcome back), or take it back: croft handoff ${ref} --undo`

  it('refuses a status change, a claim and a close, each with 409 handed_off', async () => {
    asAgent()
    todo = await fileTodo(labRef, 'Owned elsewhere')
    await link(todo, { tracker: 'github', ref: 'owner/repo#30', status: 'doing' })

    const status = await call(patchTaskRoute, 'PATCH', `/tasks/${todo}`, { ref: todo }, { status: 'doing' })
    expect(status.status).toBe(409)
    expect(status.json).toMatchObject({ code: 'handed_off', error: message(todo), tracker: 'github', handoffRef: 'owner/repo#30' })

    const claimed = await call(claimRoute, 'POST', `/tasks/${todo}/claim`, { ref: todo }, {})
    expect(claimed.status).toBe(409)
    expect(claimed.json.code).toBe('handed_off')

    for (const closing of ['done', 'cancelled']) {
      const closed = await call(patchTaskRoute, 'PATCH', `/tasks/${todo}`, { ref: todo }, { status: closing, resolution: 'Did it here.' })
      expect([closing, closed.status, closed.json.code]).toEqual([closing, 409, 'handed_off'])
    }

    // A checkpoint on an unheld todo would claim it into doing.
    const checkpoint = await call(checkpointRoute, 'POST', `/tasks/${todo}/checkpoint`, { ref: todo }, { summary: 'Where I stopped' })
    expect(checkpoint.status).toBe(409)
    expect(checkpoint.json.code).toBe('handed_off')

    expect(await show(todo)).toMatchObject({ status: 'todo', claimed_by: null, handoff: { status: 'doing' } })
  })

  it('still takes edits to the title and body, and notes, without claiming it', async () => {
    asAgent()
    const edited = await call(patchTaskRoute, 'PATCH', `/tasks/${todo}`, { ref: todo }, { title: 'Owned elsewhere, renamed', description: 'A body that explains what the tracker is doing.' })
    expect(edited.status).toBe(200)
    expect(edited.json.data.title).toBe('Owned elsewhere, renamed')

    // Sending the status it already has changes nothing, so it is not refused.
    expect((await call(patchTaskRoute, 'PATCH', `/tasks/${todo}`, { ref: todo }, { status: 'todo', title: 'Owned elsewhere' })).status).toBe(200)

    const note = await call(taskNoteRoute, 'POST', `/tasks/${todo}/notes`, { ref: todo }, { kind: 'note', note: 'Seen from the lab.' })
    expect(note.status).toBeLessThan(300)
    expect(await show(todo)).toMatchObject({ status: 'todo', claimed_by: null })
  })

  it('refuses to release a doing todo handed off after it was claimed, and lets it go once taken back', async () => {
    asAgent()
    const held = await fileTodo(labRef, 'Claimed then handed off')
    expect((await call(claimRoute, 'POST', `/tasks/${held}/claim`, { ref: held }, {})).status).toBe(200)
    await link(held, { tracker: 'github', ref: 'owner/repo#31', status: 'doing' })

    const released = await call(releaseRoute, 'POST', `/tasks/${held}/release`, { ref: held }, {})
    expect(released.status).toBe(409)
    expect(released.json.code).toBe('handed_off')

    await call(undoRoute, 'DELETE', `/tasks/${held}/handoff`, { ref: held })
    expect((await call(releaseRoute, 'POST', `/tasks/${held}/release`, { ref: held }, {})).status).toBe(200)
  })

  it('lets the tracker\'s outcome close it, which is the one way in', async () => {
    asAgent()
    const closed = await link(todo, { tracker: 'github', ref: 'owner/repo#30', status: 'done', resolution: 'Done over there.' })
    expect(closed.json.data).toMatchObject({ status: 'done', closed: true })
  })
})

describe('a hand-off outside the first link', () => {
  it('refreshes a link it already has without --force', async () => {
    asAgent()
    // A private subject's todo handed off with --force: each sync after that
    // refreshes the same link and must not be refused for it.
    const hidden = await fileTodo(privateRef, 'Forced once')
    const forced = await call(handoffRoute, 'POST', `/tasks/${hidden}/handoff`, { ref: hidden }, { tracker: 'linear', ref: 'LIN-340', force: true })
    expect(forced.status).toBe(200)
    const refreshed = await call(handoffRoute, 'POST', `/tasks/${hidden}/handoff`, { ref: hidden }, { tracker: 'linear', ref: 'LIN-340', status: 'doing' })
    expect(refreshed.status).toBe(200)
    expect(refreshed.json.data.handoff).toMatchObject({ ref: 'LIN-340', status: 'doing' })
    // A different ref is leaving again, and needs --force again.
    const moved = await call(handoffRoute, 'POST', `/tasks/${hidden}/handoff`, { ref: hidden }, { tracker: 'linear', ref: 'LIN-341' })
    expect(moved.json.code).toBe('subject_not_published')
  })
})

describe('lab only', () => {
  it('refuses a task with no subject, 422 subject_required, and names the way in', async () => {
    asAgent()
    const refused = await call(createProjectTaskRoute, 'POST', '/projects/T/tasks', { id: 'T' }, { title: 'No subject' })
    expect(refused.status).toBe(422)
    expect(refused.json.code).toBe('subject_required')
    expect(refused.json.error).toContain('croft subject todo S-12')
    expect(refused.json.error).not.toMatch(/cairn/i)
    expect((await q(`select 1 from tasks where title = 'No subject' and actor_id like $1`, [`%handoff-${RUN}%`])).rowCount).toBe(0)

    expect((await call(createProjectTaskRoute, 'POST', '/projects/NOSUCH/tasks', { id: 'NOSUCH' }, { title: 'x' })).status).toBe(404)
    expect((await call(createProjectTaskRoute, 'POST', '/projects/T/tasks', { id: 'T' }, {})).status).toBe(400)

    // A subject's own todo route is unchanged.
    const parentRef = await fileTodo(labRef, 'Through the subject')
    expect(parentRef).toMatch(/^T-\d+$/)

    // A sub-task takes its parent's subject, so it is lab work too.
    const child = await call(createProjectTaskRoute, 'POST', '/projects/T/tasks', { id: 'T' }, { title: `Child ${RUN}`, parentRef })
    expect(child.status).toBe(201)
    const row = (await q('select subject_id from tasks where id = $1', [child.json.data.id])).rows[0]
    const parentRow = (await q(`select subject_id from tasks t join projects p on p.id = t.project_id where p.key = 'T' and t.number = $1`, [Number(parentRef.slice(2))])).rows[0]
    expect(row.subject_id).toBe(parentRow.subject_id)
    expect(row.subject_id).not.toBeNull()
  })
})

describe('removed in 0.8', () => {
  const removedRoutes = [
    'src/app/api/v1/context',
    'src/app/api/v1/next',
    'src/app/api/v1/activity',
    'src/app/api/v1/projects/route.ts',
    'src/app/api/v1/projects/[id]/route.ts',
    'src/app/api/v1/projects/[id]/repos',
    'src/app/api/v1/tasks/[ref]/activity',
    'src/app/api/v1/tasks/[ref]/cairn-link',
    'src/app/api/v1/tasks/[ref]/dependencies',
    'src/app/api/v1/tasks/[ref]/mentions',
  ]

  it.each(removedRoutes)('%s is gone', (path) => {
    expect(existsSync(join(process.cwd(), path))).toBe(false)
  })

  it('left no deprecated alias on a todo or a lab project', async () => {
    asAgent()
    const todo = await fileTodo(labRef, 'No aliases')
    await link(todo, { tracker: 'linear', ref: 'LIN-1', status: 'doing' })
    const shown = await show(todo)
    for (const field of ['cairn_ref', 'cairn_status', 'cairn_synced_at']) expect(shown).not.toHaveProperty(field)
    const listed = await q('select column_name from information_schema.columns where table_name = $1', ['lab_projects'])
    expect(listed.rows.map((r) => r.column_name)).not.toContain('cairn_key')
  })

  it('dropped the tables, functions and triggers behind the removed features, and left the rest', async () => {
    const tables = await q(
      `select table_name from information_schema.tables
        where table_schema = current_schema() and table_name = any($1::text[])`,
      [['task_mentions', 'project_repos', 'task_projects', 'project_former_keys', 'task_deps']],
    )
    expect(tables.rows).toEqual([])

    const functions = await q(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = current_schema() and p.proname = any($1::text[])`,
      [[
        'task_mentions_refresh', 'task_mentions_from_note', 'task_mentions_from_comment', 'task_mentions_from_task',
        'guard_project_key_namespace', 'reject_home_project_link', 'project_rename_key', 'move_task', 'search_tasks',
      ]],
    )
    expect(functions.rows).toEqual([])

    // No function that stayed still names anything that went.
    const dangling = await q(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = current_schema() and p.prosrc ~* '(task_deps|task_mentions|task_projects|project_repos|project_former_keys|search_tasks|move_task)'`,
    )
    expect(dangling.rows).toEqual([])

    // What the lab runs on is still there.
    const kept = await q(
      `select table_name from information_schema.tables
        where table_schema = current_schema() and table_name = any($1::text[])`,
      [['projects', 'tasks', 'task_notes', 'task_comments', 'task_activity_events', 'subjects']],
    )
    expect(kept.rows).toHaveLength(6)
  })
})

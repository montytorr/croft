import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The lab, end to end through the real route handlers and a real database:
 * file a subject, move it along the board, meet the conclusion rule, give it
 * a todo that is a genuine task in project T, keep a log, find it in search,
 * and hand the todo to another tracker and read the outcome back.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { GET as listSubjectsRoute, POST as createSubjectRoute } from '@/app/api/v1/subjects/route'
import { GET as showSubjectRoute, PATCH as patchSubjectRoute } from '@/app/api/v1/subjects/[ref]/route'
import { GET as listNotesRoute, POST as addNoteRoute } from '@/app/api/v1/subjects/[ref]/notes/route'
import { GET as listTodosRoute, POST as addTodoRoute } from '@/app/api/v1/subjects/[ref]/todos/route'
import { GET as briefRoute } from '@/app/api/v1/subjects/brief/route'
import { POST as createStageRoute } from '@/app/api/v1/stages/route'
import { DELETE as deleteStageRoute } from '@/app/api/v1/stages/[id]/route'
import { POST as createTagRoute } from '@/app/api/v1/tags/route'
import { POST as cairnLinkRoute } from '@/app/api/v1/tasks/[ref]/cairn-link/route'
import { POST as handoffRoute } from '@/app/api/v1/tasks/[ref]/handoff/route'
import { GET as showTaskRoute } from '@/app/api/v1/tasks/[ref]/route'
import { GET as searchRoute } from '@/app/api/v1/search/route'
import { GET as listProjectTasksRoute } from '@/app/api/v1/projects/[id]/tasks/route'
import { PATCH as patchTagRoute } from '@/app/api/v1/tags/[id]/route'
import { GET as listStagesRoute } from '@/app/api/v1/stages/route'
import { GET as listLabProjectsRoute, POST as createLabProjectRoute } from '@/app/api/v1/lab-projects/route'
import { DELETE as deleteLabProjectRoute, PATCH as patchLabProjectRoute } from '@/app/api/v1/lab-projects/[id]/route'
import { POST as reorderLabProjectsRoute } from '@/app/api/v1/lab-projects/reorder/route'
import { listLabProjects } from '@/lib/lab/data'
import { getTask } from '@/lib/data'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://croft.example.test'
const adminId = randomUUID()
const memberId = randomUUID()
const RUN = randomUUID().slice(0, 8)
const WORD = `zebrafish${RUN.replace(/[^a-z]/g, '')}quokka`

const actorFor = (userId: string, role: 'admin' | 'member', actorType: 'human' | 'agent' = 'human') => ({
  userId,
  actorType,
  actorId: actorType === 'human' ? `lab-${role}@example.test` : `claude-code · lab-${role}@example.test`,
  userDisplayName: `Lab ${role}`,
  role,
  rateKey: `lab-${randomUUID()}`,
  sessionId: null,
  agentName: actorType === 'agent' ? 'claude-code' : undefined,
})

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

let todoProjectExisted = false
const subjectIds: string[] = []
const tagIds: string[] = []
const stageIds: string[] = []
const labProjectIds: string[] = []

beforeAll(async () => {
  for (const [id, role] of [[adminId, 'admin'], [memberId, 'member']] as const) {
    await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
      id,
      `lab-${role}-${id}@example.test`,
      'not-used',
      role,
    ])
  }
  todoProjectExisted = (await pool().query(`select 1 from projects where key = 'T'`)).rowCount === 1
})

afterAll(async () => {
  vi.unstubAllGlobals()
  if (subjectIds.length) {
    await pool().query('delete from tasks where subject_id = any($1::uuid[])', [subjectIds])
    await pool().query('delete from subjects where id = any($1::uuid[])', [subjectIds])
  }
  if (labProjectIds.length) {
    await pool().query('update subjects set project_id = null where project_id = any($1::uuid[])', [labProjectIds])
    await pool().query('delete from lab_projects where id = any($1::uuid[])', [labProjectIds])
  }
  if (tagIds.length) await pool().query('delete from tags where id = any($1::uuid[])', [tagIds])
  if (stageIds.length) await pool().query('delete from subject_stages where id = any($1::uuid[])', [stageIds])
  if (!todoProjectExisted) {
    await pool().query(`delete from projects where key = 'T' and owner_user_id = any($1::uuid[])`, [[adminId, memberId]])
  }
  await pool().query('delete from app_users where id = any($1::uuid[])', [[adminId, memberId]])
  await pool().end()
})

beforeEach(() => {
  auth.actor = actorFor(adminId, 'admin')
})

describe('the lab board', () => {
  let ref = ''
  let todoRef = ''

  it('files a subject into the first planned stage, with curated tags', async () => {
    const tag = await call(createTagRoute, 'POST', '/tags', {}, { name: `Lab-${RUN}` })
    expect(tag.status).toBe(201)
    expect(tag.json.data.name).toBe(`lab-${RUN}`)
    tagIds.push(tag.json.data.id)

    const unknownTag = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: 'x', tags: ['no-such-tag-anywhere'] })
    expect(unknownTag.status).toBe(400)

    const created = await call(createSubjectRoute, 'POST', '/subjects', {}, {
      title: `Evaluate ${WORD} for semantic recall`,
      body: 'A write-up.',
      tags: [`LAB-${RUN}`],
    })
    expect(created.status).toBe(201)
    const subject = created.json.data
    subjectIds.push(subject.id)
    ref = subject.ref
    expect(ref).toMatch(/^S-\d+$/)
    expect(subject.stage.category).toBe('planned')
    expect(subject.tags.map((t: { name: string }) => t.name)).toEqual([`lab-${RUN}`])
    expect(subject.owner).toEqual({ id: adminId, name: expect.any(String) })
    expect(subject.todos).toEqual({ open: 0, done: 0 })
  })

  it('writes a stage note on every move', async () => {
    const moved = await call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { stage: 'Exploring' })
    expect(moved.status).toBe(200)
    expect(moved.json.data.stage.name).toBe('exploring')

    const notes = await call(listNotesRoute, 'GET', `/subjects/${ref}/notes`, { ref })
    expect(notes.json.data[0]).toMatchObject({ kind: 'stage', note: 'to explore → exploring' })
  })

  it('refuses a completed stage without a conclusion, and accepts one with it', async () => {
    const refused = await call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { stage: 'done' })
    expect(refused.status).toBe(400)
    expect(refused.json.code).toBe('conclusion_required')

    const done = await call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, {
      stage: 'done',
      conclusion: 'Recall improved on the eval set.',
    })
    expect(done.status).toBe(200)
    expect(done.json.data.conclusion).toBe('Recall improved on the eval set.')
    expect(done.json.data.concluded_at).toEqual(expect.any(String))

    const reopened = await call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { stage: 'exploring' })
    expect(reopened.json.data.concluded_at).toBeNull()
  })

  it('adds a todo that is a real task in project T, linked to the subject', async () => {
    auth.actor = actorFor(adminId, 'admin', 'agent')
    const todo = await call(addTodoRoute, 'POST', `/subjects/${ref}/todos`, { ref }, { title: 'Benchmark the index' })
    expect(todo.status).toBe(201)
    todoRef = todo.json.data.ref
    expect(todoRef).toMatch(/^T-\d+$/)
    expect(todo.json.data.status).toBe('todo')

    const task = await call(showTaskRoute, 'GET', `/tasks/${todoRef}`, { ref: todoRef })
    expect(task.status).toBe(200)
    expect(task.json.data.subject_id).toBe(subjectIds[0])

    const event = await pool().query(
      `select 1 from task_activity_events where task_id = $1 and event = 'created'`,
      [todo.json.data.id],
    )
    expect(event.rowCount).toBe(1)

    const todos = await call(listTodosRoute, 'GET', `/subjects/${ref}/todos`, { ref })
    expect(todos.json.data.map((t: { ref: string }) => t.ref)).toEqual([todoRef])

    const shown = await call(showSubjectRoute, 'GET', `/subjects/${ref}`, { ref })
    expect(shown.json.data.todos).toEqual({ open: 1, done: 0 })
  })

  it('keeps notes idempotent and refuses hand-written stage notes', async () => {
    const first = await call(addNoteRoute, 'POST', `/subjects/${ref}/notes`, { ref }, { note: 'HNSW beats IVF here.', kind: 'finding' })
    expect(first.status).toBe(201)
    const again = await call(addNoteRoute, 'POST', `/subjects/${ref}/notes`, { ref }, { note: 'HNSW beats IVF here.', kind: 'finding' })
    expect(again.status).toBe(200)
    expect(again.json.data).toEqual({ duplicate: true })

    const stage = await call(addNoteRoute, 'POST', `/subjects/${ref}/notes`, { ref }, { note: 'x', kind: 'stage' })
    expect(stage.status).toBe(400)
  })

  it('is found by search, and by its ref', async () => {
    const byWord = await call(searchRoute, 'GET', `/search?q=${WORD}`)
    expect(byWord.status).toBe(200)
    // The conclusion survived the move back to exploring; `croft check` reads
    // it as answered, with the stage and the cost of opening the subject.
    expect(byWord.json.data.results[0]).toMatchObject({
      kind: 'subject',
      ref,
      status: 'exploring',
      stage: 'exploring',
      resolved: true,
      conclusion: 'Recall improved on the eval set.',
      tokens: Math.ceil(('A write-up.'.length + 'Recall improved on the eval set.'.length) / 4),
    })

    const byRef = await call(searchRoute, 'GET', `/search?q=${ref}`)
    expect(byRef.json.data.results[0]).toMatchObject({ kind: 'subject', ref })
  })

  it('lists and briefs by owner', async () => {
    const mine = await call(listSubjectsRoute, 'GET', '/subjects?owner=me')
    expect(mine.json.data.map((s: { ref: string }) => s.ref)).toContain(ref)

    const byTag = await call(listSubjectsRoute, 'GET', `/subjects?tag=lab-${RUN}`)
    expect(byTag.json.data.map((s: { ref: string }) => s.ref)).toEqual([ref])

    const brief = await call(briefRoute, 'GET', '/subjects/brief')
    // Keyed by stage NAME, every stage present (zeros too) — what the CLI renders.
    const stages = (await call(listStagesRoute, 'GET', '/stages')).json.data as { name: string }[]
    expect(Object.keys(brief.json.data.counts).sort()).toEqual(stages.map((st) => st.name).sort())
    expect(Object.values(brief.json.data.counts).every((n) => typeof n === 'number')).toBe(true)
    expect(brief.json.data.counts.exploring).toBeGreaterThanOrEqual(1)
    expect(brief.json.data.mine.map((s: { ref: string }) => s.ref)).toContain(ref)
  })

  it('refuses to delete a stage while a subject is in it; admins only', async () => {
    auth.actor = actorFor(memberId, 'member')
    const forbidden = await call(createStageRoute, 'POST', '/stages', {}, { name: `nope-${RUN}`, category: 'active' })
    expect(forbidden.status).toBe(403)

    auth.actor = actorFor(adminId, 'admin')
    const stage = await call(createStageRoute, 'POST', '/stages', {}, { name: `parked-${RUN}`, category: 'active' })
    expect(stage.status).toBe(201)
    stageIds.push(stage.json.data.id)

    await call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { stage: stage.json.data.id })
    const inUse = await call(deleteStageRoute, 'DELETE', `/stages/${stage.json.data.id}`, { id: stage.json.data.id })
    expect(inUse.status).toBe(409)
    expect(inUse.json.code).toBe('stage_in_use')

    await call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { stage: 'exploring' })
    const deleted = await call(deleteStageRoute, 'DELETE', `/stages/${stage.json.data.id}`, { id: stage.json.data.id })
    expect(deleted.status).toBe(200)
    stageIds.pop()
  })

  it('shows a todo with its subject and hand-off, and lists them per row', async () => {
    const shown = await call(showTaskRoute, 'GET', `/tasks/${todoRef}`, { ref: todoRef })
    expect(shown.json.data.subject).toEqual({
      ref,
      number: Number(ref.slice(2)),
      title: `Evaluate ${WORD} for semantic recall`,
      project: null,
      visibility: 'lab',
    })
    expect(shown.json.data).toMatchObject({ handoff: null, cairn_ref: null, cairn_status: null, cairn_synced_at: null })
    expect(shown.json.data).not.toHaveProperty('handoff_ref')

    const digest = await call(showTaskRoute, 'GET', `/tasks/${todoRef}?view=digest`, { ref: todoRef })
    expect(digest.json.data.subject).toMatchObject({ ref })
    expect(digest.json.data).not.toHaveProperty('cairn_ref')
    expect(digest.json.data).not.toHaveProperty('handoff')

    const listed = await call(listProjectTasksRoute, 'GET', '/projects/T/tasks?limit=200', { id: 'T' })
    const row = listed.json.data.tasks.find((t: { number: number }) => `T-${t.number}` === todoRef)
    expect(row).toMatchObject({ subject_ref: ref, handoff: null, cairn_ref: null, cairn_status: null })
    // The raw `{number}` embed is folded into subject_ref; `subject` is the lab's shape (0.3).
    expect(row.subject).toEqual({ ref, number: Number(ref.slice(2)), title: `Evaluate ${WORD} for semantic recall`, project: null, visibility: 'lab' })

    const page = await getTask(adminId, 'T', Number(todoRef.slice(2)), { id: adminId, role: 'admin' })
    expect(page?.subject).toEqual({ ref, number: Number(ref.slice(2)), title: `Evaluate ${WORD} for semantic recall`, visibility: 'lab' })
  })

  it('hands a todo off and writes the outcome to the log exactly once', async () => {
    auth.actor = actorFor(adminId, 'admin', 'agent')
    const handoffRef = `owner/repo#${100_000 + Math.floor(Math.random() * 900_000)}`
    const url = `https://github.com/${handoffRef.replace('#', '/issues/')}`
    const linked = await call(handoffRoute, 'POST', `/tasks/${todoRef}/handoff`, { ref: todoRef }, { tracker: 'github', ref: handoffRef, url, status: 'todo' })
    expect(linked.status).toBe(200)
    expect(linked.json.data).toMatchObject({
      ref: todoRef,
      handoff: { tracker: 'github', ref: handoffRef, url, status: 'todo' },
      // The deprecated aliases are only for tracker cairn.
      cairn_ref: null,
      cairn_status: null,
    })

    // The agent reports what its own adapter read; the server stores no key.
    const body = { tracker: 'github', ref: handoffRef, status: 'done', resolution: 'Shipped the index.' }
    const first = await call(handoffRoute, 'POST', `/tasks/${todoRef}/handoff`, { ref: todoRef }, body)
    expect(first.status).toBe(200)
    expect(first.json.data).toMatchObject({ handoff: { status: 'done', url }, noted: true, closed: true })
    const second = await call(handoffRoute, 'POST', `/tasks/${todoRef}/handoff`, { ref: todoRef }, body)
    expect(second.status).toBe(200)
    expect(second.json.data).toMatchObject({ handoff: { status: 'done' }, noted: false, closed: false })

    const notes = await call(listNotesRoute, 'GET', `/subjects/${ref}/notes`, { ref })
    const outcome = notes.json.data.filter((n: { note: string }) => n.note.startsWith(`${handoffRef} done`))
    expect(outcome).toHaveLength(1)
    expect(outcome[0]).toMatchObject({ kind: 'finding', note: `${handoffRef} done: Shipped the index.` })
    const handed = notes.json.data.filter((n: { kind: string; note: string }) => n.kind === 'handoff' && n.note.includes(handoffRef))
    expect(handed).toEqual([expect.objectContaining({ note: `${todoRef} handed off to github as ${handoffRef}` })])

    // The tracker owns a handed-off todo's status: its close closed the todo, once.
    const task = await call(showTaskRoute, 'GET', `/tasks/${todoRef}`, { ref: todoRef })
    expect(task.json.data).toMatchObject({
      handoff: { tracker: 'github', status: 'done' },
      status: 'done',
      resolution: `Closed in github as ${handoffRef}: Shipped the index.`,
      resolution_kind: 'verified',
      claimed_by: null,
    })
    const resolved = await pool().query(
      `select count(*)::int as n from task_activity_events where task_id = $1 and event = 'resolved'`,
      [task.json.data.id],
    )
    expect(resolved.rows[0].n).toBe(1)
    expect((await call(showSubjectRoute, 'GET', `/subjects/${ref}`, { ref })).json.data.todos).toEqual({ open: 0, done: 1 })

    const listed = await call(listProjectTasksRoute, 'GET', '/projects/T/tasks?limit=200', { id: 'T' })
    expect(listed.json.data.tasks.find((t: { number: number }) => `T-${t.number}` === todoRef)).toMatchObject({
      subject_ref: ref,
      handoff: { tracker: 'github', ref: handoffRef, status: 'done' },
    })
  })

  it('takes an ended status through the deprecated cairn-link the way 0.6 sync does: the note once, the todo closed', async () => {
    auth.actor = actorFor(adminId, 'admin', 'agent')
    const todo = await call(addTodoRoute, 'POST', `/subjects/${ref}/todos`, { ref }, { title: 'Wire the flag' })
    const localRef = todo.json.data.ref as string
    const cairnRef = `CAIRN-${100_000 + Math.floor(Math.random() * 900_000)}`
    await call(cairnLinkRoute, 'POST', `/tasks/${localRef}/cairn-link`, { ref: localRef }, { cairnRef, cairnStatus: 'doing' })

    const ended = await call(cairnLinkRoute, 'POST', `/tasks/${localRef}/cairn-link`, { ref: localRef }, {
      cairnRef,
      cairnStatus: 'cancelled',
      cairnResolution: 'Superseded by the new pipeline.',
      cairnResolutionKind: 'superseded',
    })
    expect(ended.status).toBe(200)
    expect(ended.json.data).toMatchObject({
      ref: localRef,
      cairn_ref: cairnRef,
      cairn_status: 'cancelled',
      handoff: { tracker: 'cairn', ref: cairnRef, status: 'cancelled' },
      status: 'cancelled',
      noted: true,
      closed: true,
    })

    const again = await call(cairnLinkRoute, 'POST', `/tasks/${localRef}/cairn-link`, { ref: localRef }, {
      cairnRef,
      cairnStatus: 'cancelled',
      cairnResolution: 'Reworded later.',
    })
    expect(again.json.data).toMatchObject({ noted: false, closed: false, status: 'cancelled' })

    const notes = await call(listNotesRoute, 'GET', `/subjects/${ref}/notes`, { ref })
    const outcome = notes.json.data.filter((n: { note: string }) => n.note.startsWith(`${cairnRef} cancelled`))
    expect(outcome).toEqual([expect.objectContaining({ kind: 'note', note: `${cairnRef} cancelled: Superseded by the new pipeline.` })])

    const task = await call(showTaskRoute, 'GET', `/tasks/${localRef}`, { ref: localRef })
    expect(task.json.data).toMatchObject({
      status: 'cancelled',
      resolution: `Closed in cairn as ${cairnRef}: Superseded by the new pipeline.`,
      resolution_kind: 'superseded',
    })
  })

  it('lists archived subjects on request, and filters by any of several tags', async () => {
    const other = await call(createTagRoute, 'POST', '/tags', {}, { name: `other-${RUN}` })
    tagIds.push(other.json.data.id)
    const archived = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `Archived ${WORD}`, tags: [`other-${RUN}`] })
    subjectIds.push(archived.json.data.id)
    const archivedRef = archived.json.data.ref as string
    await call(patchSubjectRoute, 'PATCH', `/subjects/${archivedRef}`, { ref: archivedRef }, { archived: true })

    const refs = async (query: string) =>
      (await call(listSubjectsRoute, 'GET', `/subjects?${query}`)).json.data.map((x: { ref: string }) => x.ref) as string[]
    const tags = `tag=lab-${RUN},other-${RUN}`

    expect(await refs(tags)).toEqual([ref])
    expect((await refs(`${tags}&archived=include`)).sort()).toEqual([ref, archivedRef].sort())
    expect(await refs(`${tags}&archived=only`)).toEqual([archivedRef])
    // `true` keeps meaning archived only.
    expect(await refs(`${tags}&archived=true`)).toEqual([archivedRef])
    expect(await refs(`tag=other-${RUN}&archived=include`)).toEqual([archivedRef])
    expect((await call(listSubjectsRoute, 'GET', '/subjects?archived=sometimes')).status).toBe(400)
  })

  it('moves the live-update pulse on every lab change', async () => {
    const pulse = async () => (await pool().query('select croft_pulse(null) as p')).rows[0].p as string
    const changes: [string, () => Promise<unknown>][] = [
      ['a note', () => call(addNoteRoute, 'POST', `/subjects/${ref}/notes`, { ref }, { note: `pulse ${randomUUID()}` })],
      ['a subject edit', () => call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { title: `Evaluate ${WORD} again` })],
      ['a tag rename', () => call(patchTagRoute, 'PATCH', `/tags/${tagIds[0]}`, { id: tagIds[0]! }, { color: '#123456' })],
      // A no-op write still moves updated_at, so the board's real stages are left as they were.
      ['a stage change', () => pool().query(`update subject_stages set color = color where name = 'rejected'`)],
      ['a subject re-tagged', () => pool().query('delete from subject_tags where subject_id = $1', [subjectIds[0]])],
    ]
    for (const [what, change] of changes) {
      const before = await pulse()
      // Timestamps have microsecond resolution; a beat keeps two writes apart.
      await new Promise((r) => setTimeout(r, 5))
      await change()
      expect(await pulse(), `the pulse missed ${what}`).not.toBe(before)
    }
  })
})

describe('lab projects', () => {
  const name = `Trig-${RUN}`
  let projectId = ''
  let otherId = ''
  let subjectRef = ''

  it('are curated by administrators: members read, admins write, names unique in any case', async () => {
    auth.actor = actorFor(memberId, 'member')
    const refused = await call(createLabProjectRoute, 'POST', '/lab-projects', {}, { name })
    expect(refused.status).toBe(403)
    expect(refused.json.code).toBe('forbidden')

    auth.actor = actorFor(adminId, 'admin', 'agent')
    const created = await call(createLabProjectRoute, 'POST', '/lab-projects', {}, { name, color: '#6B7FA6', handoffTracker: 'Cairn', handoffTarget: 'TRIG' })
    expect(created.status).toBe(201)
    expect(created.json.data).toEqual({
      id: expect.any(String),
      name,
      color: '#6b7fa6',
      handoff_tracker: 'cairn',
      handoff_target: 'TRIG',
      cairn_key: 'TRIG',
      position: expect.any(Number),
    })
    projectId = created.json.data.id
    labProjectIds.push(projectId)

    const twin = await call(createLabProjectRoute, 'POST', '/lab-projects', {}, { name: name.toUpperCase() })
    expect(twin.status).toBe(409)
    expect(twin.json.code).toBe('conflict')

    const badKey = await call(createLabProjectRoute, 'POST', '/lab-projects', {}, { name: `x-${RUN}`, cairnKey: 'no-such' })
    expect(badKey.status).toBe(400)
    const half = await call(createLabProjectRoute, 'POST', '/lab-projects', {}, { name: `x-${RUN}`, handoffTracker: 'github' })
    expect(half.status).toBe(400)

    const other = await call(createLabProjectRoute, 'POST', '/lab-projects', {}, { name: `Croft-${RUN}` })
    expect(other.json.data).toMatchObject({ handoff_tracker: null, handoff_target: null, cairn_key: null })
    otherId = other.json.data.id
    labProjectIds.push(otherId)

    auth.actor = actorFor(memberId, 'member')
    const listed = await call(listLabProjectsRoute, 'GET', '/lab-projects')
    expect(listed.status).toBe(200)
    expect(listed.json.data.find((p: { id: string }) => p.id === projectId)).toMatchObject({ name, handoff_tracker: 'cairn', handoff_target: 'TRIG', cairn_key: 'TRIG', subjects: 0 })
    expect((await listLabProjects({ id: adminId, role: 'admin' })).some((p) => p.id === projectId)).toBe(true)
    const memberPatch = await call(patchLabProjectRoute, 'PATCH', `/lab-projects/${projectId}`, { id: projectId }, { name: 'x' })
    expect(memberPatch.status).toBe(403)
  })

  it('rename, recolour and re-point; null clears the hand-off, and cairnKey still says it the old way', async () => {
    const patch = (body: unknown) => call(patchLabProjectRoute, 'PATCH', `/lab-projects/${otherId}`, { id: otherId }, body)
    const github = await patch({ handoffTracker: 'github', handoffTarget: 'owner/repo' })
    expect(github.json.data).toMatchObject({ handoff_tracker: 'github', handoff_target: 'owner/repo', cairn_key: null })
    expect((await patch({ color: '#123456' })).json.data).toMatchObject({ color: '#123456', handoff_tracker: 'github', handoff_target: 'owner/repo' })
    expect((await patch({ handoffTracker: null, handoffTarget: null })).json.data).toMatchObject({ handoff_tracker: null, handoff_target: null })
    // Half a pair is refused, and so is the alias beside the pair.
    expect((await patch({ handoffTarget: 'owner/repo' })).status).toBe(400)
    expect((await patch({ cairnKey: 'CROFT', handoffTracker: 'cairn', handoffTarget: 'CROFT' })).status).toBe(400)
    // Deprecated (0.7): cairnKey is tracker cairn and that target.
    expect((await patch({ cairnKey: 'CROFT' })).json.data).toMatchObject({ handoff_tracker: 'cairn', handoff_target: 'CROFT', cairn_key: 'CROFT' })
    expect((await patch({ cairnKey: null })).json.data).toMatchObject({ handoff_tracker: null, handoff_target: null, cairn_key: null })
    await patch({ cairnKey: 'CROFT' })
    expect((await patch({ cairnKey: '' })).json.data.cairn_key).toBeNull()
    const taken = await patch({ name: name.toLowerCase() })
    expect(taken.status).toBe(409)
    const missing = await call(patchLabProjectRoute, 'PATCH', `/lab-projects/${randomUUID()}`, { id: randomUUID() }, { color: '#000000' })
    expect(missing.status).toBe(404)
  })

  it('reorders when every project is named once', async () => {
    const all = (await listLabProjects({ id: adminId, role: 'admin' })).map((p) => p.id)
    const reversed = [...all].reverse()
    const partial = await call(reorderLabProjectsRoute, 'POST', '/lab-projects/reorder', {}, { ids: [projectId] })
    expect(partial.status).toBe(400)
    expect(partial.json.code).toBe('validation_failed')
    const reordered = await call(reorderLabProjectsRoute, 'POST', '/lab-projects/reorder', {}, { ids: reversed })
    expect(reordered.status).toBe(200)
    expect(reordered.json.data.map((p: { id: string }) => p.id)).toEqual(reversed)
  })

  it('a subject is filed into one by name or id, moved, taken out, and refused an unknown one with the valid list', async () => {
    const unknown = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: 'x', project: `nope-${RUN}` })
    expect(unknown.status).toBe(400)
    expect(unknown.json.code).toBe('validation_failed')
    expect(unknown.json.valid).toContain(name)

    const created = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `Projected ${WORD}`, project: name.toLowerCase() })
    expect(created.status).toBe(201)
    subjectIds.push(created.json.data.id)
    subjectRef = created.json.data.ref
    expect(created.json.data.project).toEqual({
      id: projectId,
      name,
      color: '#6b7fa6',
      handoff_tracker: 'cairn',
      handoff_target: 'TRIG',
      cairn_key: 'TRIG',
      position: expect.any(Number),
    })

    const patch = (body: unknown) => call(patchSubjectRoute, 'PATCH', `/subjects/${subjectRef}`, { ref: subjectRef }, body)
    expect((await patch({ project: otherId })).json.data.project.id).toBe(otherId)
    expect((await patch({ project: null })).json.data.project).toBeNull()
    expect((await patch({ project: `nope-${RUN}` })).status).toBe(400)
    const back = await patch({ project: name })
    expect(back.json.data.project.id).toBe(projectId)
    // Nothing in the log: a project change is an edit, not an event.
    const notes = await call(listNotesRoute, 'GET', `/subjects/${subjectRef}/notes`, { ref: subjectRef })
    expect(notes.json.data).toEqual([])
  })

  it('filters the board by project name, id, none, or a comma list', async () => {
    const refs = async (query: string) =>
      (await call(listSubjectsRoute, 'GET', `/subjects?q=${WORD}&archived=include&${query}`)).json.data.map((x: { ref: string }) => x.ref) as string[]
    expect(await refs(`project=${encodeURIComponent(name.toUpperCase())}`)).toEqual([subjectRef])
    expect(await refs(`project=${projectId}`)).toEqual([subjectRef])
    expect(await refs(`project=Croft-${RUN}`)).toEqual([])
    const none = await refs('project=none')
    expect(none).not.toContain(subjectRef)
    expect(none.length).toBeGreaterThan(0)
    expect((await refs(`project=none,${encodeURIComponent(name)}`)).sort()).toEqual([...none, subjectRef].sort())
    const listed = await call(listSubjectsRoute, 'GET', `/subjects?project=${encodeURIComponent(name)}`)
    expect(listed.json.data[0].project).toMatchObject({ name, handoff_tracker: 'cairn', handoff_target: 'TRIG', cairn_key: 'TRIG' })
  })

  it("shows a todo's subject with its project and hand-off target, for croft handoff", async () => {
    const todo = await call(addTodoRoute, 'POST', `/subjects/${subjectRef}/todos`, { ref: subjectRef }, { title: 'Ship it behind a flag' })
    expect(todo.status).toBe(201)
    const shown = await call(showTaskRoute, 'GET', `/tasks/${todo.json.data.ref}`, { ref: todo.json.data.ref })
    expect(shown.json.data.subject).toMatchObject({ ref: subjectRef, project: { name, handoff_tracker: 'cairn', handoff_target: 'TRIG', cairn_key: 'TRIG' } })
    const digest = await call(showTaskRoute, 'GET', `/tasks/${todo.json.data.ref}?view=digest`, { ref: todo.json.data.ref })
    expect(digest.json.data.subject.project).toEqual({ name, handoff_tracker: 'cairn', handoff_target: 'TRIG', cairn_key: 'TRIG' })
  })

  it('refuses to delete a project while a subject, archived or not, is in it', async () => {
    await call(patchSubjectRoute, 'PATCH', `/subjects/${subjectRef}`, { ref: subjectRef }, { archived: true })
    const counted = (await listLabProjects({ id: adminId, role: 'admin' })).find((p) => p.id === projectId)
    expect(counted?.subjects).toBe(1)

    auth.actor = actorFor(memberId, 'member')
    expect((await call(deleteLabProjectRoute, 'DELETE', `/lab-projects/${projectId}`, { id: projectId })).status).toBe(403)
    auth.actor = actorFor(adminId, 'admin')

    const inUse = await call(deleteLabProjectRoute, 'DELETE', `/lab-projects/${projectId}`, { id: projectId })
    expect(inUse.status).toBe(409)
    expect(inUse.json).toMatchObject({ code: 'project_in_use', subjects: 1 })

    await call(patchSubjectRoute, 'PATCH', `/subjects/${subjectRef}`, { ref: subjectRef }, { project: null })
    const deleted = await call(deleteLabProjectRoute, 'DELETE', `/lab-projects/${projectId}`, { id: projectId })
    expect(deleted.status).toBe(200)
    expect(deleted.json.data).toEqual({ id: projectId, deleted: true })
    expect((await call(deleteLabProjectRoute, 'DELETE', `/lab-projects/${projectId}`, { id: projectId })).status).toBe(404)
  })

  it('moves the live-update pulse when a project changes', async () => {
    const pulse = async () => (await pool().query('select croft_pulse(null) as p')).rows[0].p as string
    const before = await pulse()
    await new Promise((r) => setTimeout(r, 5))
    await call(patchLabProjectRoute, 'PATCH', `/lab-projects/${otherId}`, { id: otherId }, { color: '#654321' })
    expect(await pulse()).not.toBe(before)
  })
})

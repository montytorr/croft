import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * v0.4 private & member-scoped subjects, through the real route handlers and
 * a real database: the leak suite. This is the proof the feature does not
 * leak, so it is deliberately exhaustive rather than elegant.
 *
 * A owns a private subject P in a lab project, with a private todo TP (notes,
 * a comment, a label, a file, a claim, a mention of a lab todo, a parent and
 * a dependency on that lab todo), a closed private todo, a deleted one, a
 * human note, a subject file and a log. B is added as a member later. C is an
 * outsider. D is an administrator.
 *
 * For C and D — until A is deactivated — every route in the inventory
 * answers `not_found` exactly as for a ref that names nothing, lists
 * nothing, and reports the same counts as before P existed. B sees it once
 * added. Publishing is one-way; pushing a non-lab todo needs `force`.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { GET as listSubjectsRoute, POST as createSubjectRoute } from '@/app/api/v1/subjects/route'
import { GET as briefRoute } from '@/app/api/v1/subjects/brief/route'
import { GET as showSubjectRoute, PATCH as patchSubjectRoute } from '@/app/api/v1/subjects/[ref]/route'
import { GET as subjectNotesRoute, POST as addSubjectNoteRoute } from '@/app/api/v1/subjects/[ref]/notes/route'
import { GET as subjectTodosRoute, POST as addTodoRoute } from '@/app/api/v1/subjects/[ref]/todos/route'
import { GET as humanNotesRoute, POST as addHumanNoteRoute } from '@/app/api/v1/subjects/[ref]/human-notes/route'
import { DELETE as deleteHumanNoteRoute, PATCH as patchHumanNoteRoute } from '@/app/api/v1/subjects/[ref]/human-notes/[id]/route'
import { GET as subjectFilesRoute, POST as uploadSubjectFileRoute } from '@/app/api/v1/subjects/[ref]/attachments/route'
import { DELETE as deleteSubjectFileRoute } from '@/app/api/v1/subjects/[ref]/attachments/[id]/route'
import { GET as membersRoute, POST as addMemberRoute } from '@/app/api/v1/subjects/[ref]/members/route'
import { DELETE as removeMemberRoute } from '@/app/api/v1/subjects/[ref]/members/[userId]/route'
import { POST as publishRoute } from '@/app/api/v1/subjects/[ref]/publish/route'
import { DELETE as deleteTaskRoute, GET as showTaskRoute, PATCH as patchTaskRoute } from '@/app/api/v1/tasks/[ref]/route'
import { GET as taskNotesRoute, POST as addTaskNoteRoute } from '@/app/api/v1/tasks/[ref]/notes/route'
import { DELETE as deleteTaskNoteRoute } from '@/app/api/v1/tasks/[ref]/notes/[id]/route'
import { GET as commentsRoute, POST as addCommentRoute } from '@/app/api/v1/tasks/[ref]/comments/route'
import { GET as taskFilesRoute, POST as uploadTaskFileRoute } from '@/app/api/v1/tasks/[ref]/attachments/route'
import { GET as taskActivityRoute, POST as addEvidenceRoute } from '@/app/api/v1/tasks/[ref]/activity/route'
import { GET as childrenRoute } from '@/app/api/v1/tasks/[ref]/children/route'
import {
  DELETE as removeDependencyRoute,
  GET as dependenciesRoute,
  POST as addDependencyRoute,
} from '@/app/api/v1/tasks/[ref]/dependencies/route'
import { GET as mentionsRoute } from '@/app/api/v1/tasks/[ref]/mentions/route'
import { POST as claimRoute } from '@/app/api/v1/tasks/[ref]/claim/route'
import { POST as releaseRoute } from '@/app/api/v1/tasks/[ref]/release/route'
import { POST as beatRoute } from '@/app/api/v1/tasks/[ref]/beat/route'
import { POST as blockRoute } from '@/app/api/v1/tasks/[ref]/block/route'
import { POST as checkpointRoute } from '@/app/api/v1/tasks/[ref]/checkpoint/route'
import { POST as cairnLinkRoute } from '@/app/api/v1/tasks/[ref]/cairn-link/route'
import { GET as attachmentRoute, DELETE as deleteAttachmentRoute } from '@/app/api/v1/attachments/[id]/route'
import { GET as contentRoute } from '@/app/api/v1/attachments/[id]/content/route'
import { GET as projectTasksRoute } from '@/app/api/v1/projects/[id]/tasks/route'
import { GET as projectRoute } from '@/app/api/v1/projects/[id]/route'
import { GET as searchRoute } from '@/app/api/v1/search/route'
import { GET as activityRoute } from '@/app/api/v1/activity/route'
import { GET as contextRoute } from '@/app/api/v1/context/route'
import { GET as nextRoute } from '@/app/api/v1/next/route'
import { POST as reconcileRoute } from '@/app/api/v1/reconcile/route'
import { POST as cairnSyncRoute } from '@/app/api/v1/integrations/cairn/sync/route'
import { GET as labProjectsRoute, POST as createLabProjectRoute } from '@/app/api/v1/lab-projects/route'
import { GET as labelsRoute } from '@/app/api/v1/labels/route'
import {
  getDuplicateOf,
  getParent,
  getTask,
  listActivity,
  listAllTasks,
  listAlsoProjects,
  listAttachments,
  listChildren,
  listComments,
  listNotes,
  listRelations,
  listTaskAttachments,
  listTasks,
} from '@/lib/data'
import { listBoardTasks } from '@/lib/board-data'
import {
  getSubject,
  listLabProjects,
  listLabTodos,
  listSubjectAttachments,
  listSubjectHumanNotes,
  listSubjectNotes,
  listSubjects,
  listSubjectTodos,
} from '@/lib/lab/data'
import { mentionsOf } from '@/lib/api/mentions'
import type { Viewer } from '@/lib/api/visibility'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')
process.env.CROFT_SECRET_KEY ??= randomBytes(32).toString('hex')

const ORIGIN = 'https://croft.example.test'
const RUN = randomUUID().replace(/[^a-z]/g, '').slice(0, 6)
/** Only the private subject and its todos carry this word. */
const WORD = `pangolin${RUN}ocelot`
const LABEL = `hush-${RUN}`

const A = randomUUID()
const B = randomUUID()
const C = randomUUID()
const D = randomUUID()
const USERS = [A, B, C, D]
const emailOf = (id: string) => `vis-${id.slice(0, 8)}@example.test`

type Role = 'admin' | 'member'
const ROLE: Record<string, Role> = { [A]: 'member', [B]: 'member', [C]: 'member', [D]: 'admin' }
const viewer = (id: string): Viewer => ({ id, role: ROLE[id]! })

const actorFor = (userId: string, actorType: 'human' | 'agent' = 'human', agentName?: string) => ({
  userId,
  actorType,
  actorId: actorType === 'human' ? emailOf(userId) : `${agentName ?? 'claude-code'} · ${emailOf(userId)}`,
  userDisplayName: emailOf(userId),
  role: ROLE[userId],
  rateKey: `vis-${randomUUID()}`,
  sessionId: null,
  agentName: actorType === 'agent' ? (agentName ?? 'claude-code') : undefined,
})
const as = (userId: string, actorType: 'human' | 'agent' = 'human', agentName?: string) => {
  auth.actor = actorFor(userId, actorType, agentName)
}

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>
type Result = { status: number; json: Record<string, any>; location: string | null }

const call = async <P extends Record<string, string>>(
  handler: Handler<P>,
  method: string,
  path: string,
  params: P = {} as P,
  body?: unknown,
): Promise<Result> => {
  const response = await handler(
    new Request(`${ORIGIN}/api/v1${path}`, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', authorization: 'Bearer test' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  )
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : {}, location: response.headers.get('location') }
}

const upload = async <P extends Record<string, string>>(handler: Handler<P>, path: string, params: P, file: File) => {
  const form = new FormData()
  form.append('file', file)
  const response = await handler(
    new Request(`${ORIGIN}/api/v1${path}`, { method: 'POST', headers: { authorization: 'Bearer test' }, body: form }),
    { params: Promise.resolve(params) },
  )
  return { status: response.status, json: (await response.json()) as Record<string, any> }
}

const q = (sql: string, params: unknown[] = []) => pool().query(sql, params)
const pulse = async (id: string) => (await q('select croft_pulse($1, null) as p', [id])).rows[0].p as string

/** What a subject ref that names nothing answers: the bar a hidden one must meet exactly. */
const missingSubject = (raw: string) => ({
  success: false,
  code: 'not_found',
  error: `No subject ${raw}. Subjects are addressed as S-12.`,
})
const missingTask = (raw: string) => ({ success: false, code: 'not_found', error: `No task ${raw}.` })

let attachmentDir = ''
let todoProjectExisted = false
let savedConnection: Record<string, unknown> | null = null
const subjectIds: string[] = []
const labProjectIds: string[] = []

// The fixture, filled in by `setup`.
let projectName = ''
let labProjectId = ''
const P = { id: '', ref: '', number: 0, stage: '' }
const L = { id: '', ref: '' }
const TP = { id: '', ref: '' }
const TP2 = { id: '', ref: '' }
const TP3 = { ref: '' }
const TL = { id: '', ref: '' }
let tProjectId = ''
let humanNoteId = ''
let taskNoteId = ''
let subjectFileId = ''
let taskFileId = ''

/** C's view of every count, before P existed: nothing about P may move it. */
type Counts = Awaited<ReturnType<typeof countsFor>>
let before: Counts

const countsFor = async (id: string) => {
  as(id)
  const brief = await call(briefRoute, 'GET', '/subjects/brief')
  const labProjects = await call(labProjectsRoute, 'GET', '/lab-projects')
  const labels = await call(labelsRoute, 'GET', '/labels')
  const tasks = await call(projectTasksRoute, 'GET', '/projects/T/tasks?limit=1', { id: 'T' })
  const project = await call(projectRoute, 'GET', '/projects/T', { id: 'T' })
  const next = await call(nextRoute, 'GET', '/next?project=T')
  const board = await listBoardTasks(id, { includeClosed: true }, viewer(id))
  const boardOpen = await listBoardTasks(id, {}, viewer(id))
  const all = await listAllTasks(id, {}, viewer(id))
  const page = tProjectId ? await listTasks(tProjectId, {}, viewer(id)) : null
  const label = (labels.json.data as { label?: string; name?: string; count?: number; n?: number }[]).find(
    (l) => (l.label ?? l.name) === LABEL,
  )
  return {
    brief: brief.json.data.counts as Record<string, number>,
    mine: (brief.json.data.mine as { id: string }[]).map((s) => s.id),
    labProject: (labProjects.json.data as { id: string; subjects: number }[]).find((p) => p.id === labProjectId)?.subjects,
    label: label ?? null,
    tasksCount: tasks.status === 200 ? (tasks.json.data.count as number) : null,
    taskCount: project.status === 200 ? (project.json.data.task_count as number) : null,
    considered: next.status === 200 ? (next.json.data.considered as number) : null,
    boardTotal: board.tasks.length,
    boardClosedHidden: boardOpen.closedHidden,
    allClosedHidden: all.closedHidden,
    pageTotal: page?.total ?? null,
    pageClosedHidden: page?.closedHidden ?? null,
  }
}

beforeAll(async () => {
  attachmentDir = await mkdtemp(join(tmpdir(), 'croft-visibility-'))
  process.env.CROFT_ATTACHMENT_DIR = attachmentDir
  process.env.CROFT_ATTACHMENT_SIGNING_KEY ??= 'integration-signing-key-with-enough-entropy'
  for (const id of USERS) {
    await q('insert into app_users (id, email, encrypted_password, role) values ($1, $2, $3, $4)', [
      id,
      emailOf(id),
      'not-used',
      ROLE[id],
    ])
  }
  todoProjectExisted = (await q(`select 1 from projects where key = 'T'`)).rowCount === 1
  savedConnection = (await q('select * from cairn_connection where id')).rows[0] ?? null
})

afterAll(async () => {
  vi.unstubAllGlobals()
  if (subjectIds.length) {
    await q('delete from tasks where subject_id = any($1::uuid[])', [subjectIds])
    await q('delete from subjects where id = any($1::uuid[])', [subjectIds])
  }
  if (labProjectIds.length) await q('delete from lab_projects where id = any($1::uuid[])', [labProjectIds])
  if (!todoProjectExisted) await q(`delete from projects where key = 'T' and owner_user_id = any($1::uuid[])`, [USERS])
  await q('delete from cairn_connection where id')
  if (savedConnection) {
    const c = savedConnection
    await q(
      `insert into cairn_connection (id, url, api_key, api_key_plaintext, last_synced_at, updated_at, updated_by)
       values (true, $1, $2, $3, $4, $5, $6)`,
      [c.url, c.api_key, c.api_key_plaintext ?? false, c.last_synced_at, c.updated_at, c.updated_by],
    )
  }
  await q('delete from app_users where id = any($1::uuid[])', [USERS])
  await pool().end()
  await rm(attachmentDir, { recursive: true, force: true })
})

describe('setup', () => {
  it('records the outsider\'s counts, then files the lab side of the fixture', async () => {
    as(D)
    projectName = `Vis-${RUN}`
    const project = await call(createLabProjectRoute, 'POST', '/lab-projects', {}, { name: projectName, color: '#4f8c86' })
    expect(project.status).toBe(201)
    labProjectId = project.json.data.id
    labProjectIds.push(labProjectId)

    // A lab subject with a todo: the thing the private todo will mention,
    // hang under and depend on. Filed first so project T exists for counting.
    as(A)
    const lab = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `Lab side ${RUN}` })
    expect(lab.status).toBe(201)
    expect(lab.json.data).toMatchObject({ visibility: 'lab', members: [] })
    Object.assign(L, { id: lab.json.data.id, ref: lab.json.data.ref })
    subjectIds.push(L.id)
    const todo = await call(addTodoRoute, 'POST', `/subjects/${L.ref}/todos`, { ref: L.ref }, { title: `Lab todo ${RUN}` })
    expect(todo.status).toBe(201)
    Object.assign(TL, { id: todo.json.data.id, ref: todo.json.data.ref })
    tProjectId = (await q(`select id from projects where key = 'T'`)).rows[0].id

    before = await countsFor(C)
  })

  it('files the private subject and everything on it', async () => {
    as(A)
    const created = await call(createSubjectRoute, 'POST', '/subjects', {}, {
      title: `Private ${WORD}`,
      body: `The write-up about ${WORD}.`,
      visibility: 'private',
      project: projectName,
    })
    expect(created.status).toBe(201)
    expect(created.json.data).toMatchObject({ visibility: 'private', members: [], owner: { id: A } })
    Object.assign(P, {
      id: created.json.data.id,
      ref: created.json.data.ref,
      number: created.json.data.number,
      stage: created.json.data.stage.name,
    })
    subjectIds.push(P.id)

    const addTodo = async (title: string) => {
      const res = await call(addTodoRoute, 'POST', `/subjects/${P.ref}/todos`, { ref: P.ref }, {
        title,
        description: `Todo body about ${WORD}.`,
      })
      expect(res.status).toBe(201)
      return res.json.data as { id: string; ref: string }
    }
    Object.assign(TP, await addTodo(`${WORD} private todo`))
    Object.assign(TP2, await addTodo(`${WORD} closed private todo`))
    const doomed = await addTodo(`${WORD} doomed private todo`)
    TP3.ref = doomed.ref

    expect((await call(addSubjectNoteRoute, 'POST', `/subjects/${P.ref}/notes`, { ref: P.ref }, { note: `Found ${WORD}.`, kind: 'finding' })).status).toBe(201)
    const human = await call(addHumanNoteRoute, 'POST', `/subjects/${P.ref}/human-notes`, { ref: P.ref }, { body: `My ${WORD} note.` })
    expect(human.status).toBe(201)
    humanNoteId = human.json.data.id

    const subjectFile = await upload(uploadSubjectFileRoute, `/subjects/${P.ref}/attachments`, { ref: P.ref }, new File([`${WORD}`], 'p.txt', { type: 'text/plain' }))
    expect(subjectFile.status).toBe(201)
    subjectFileId = subjectFile.json.data.id
    const taskFile = await upload(uploadTaskFileRoute, `/tasks/${TP.ref}/attachments`, { ref: TP.ref }, new File([`${WORD}`], 't.txt', { type: 'text/plain' }))
    expect(taskFile.status).toBe(201)
    taskFileId = taskFile.json.data.id

    const note = await call(addTaskNoteRoute, 'POST', `/tasks/${TP.ref}/notes`, { ref: TP.ref }, {
      note: `Waiting on ${TL.ref} before ${WORD} can move.`,
      kind: 'decision',
    })
    expect(note.status).toBe(201)
    taskNoteId = note.json.data.id ?? note.json.data.note?.id
    expect((await call(addCommentRoute, 'POST', `/tasks/${TP.ref}/comments`, { ref: TP.ref }, { content: `Comment on ${WORD}.` })).status).toBe(201)
    expect((await call(patchTaskRoute, 'PATCH', `/tasks/${TP.ref}`, { ref: TP.ref }, { labels: [LABEL], parentRef: TL.ref })).status).toBe(200)
    expect((await call(addDependencyRoute, 'POST', `/tasks/${TL.ref}/dependencies`, { ref: TL.ref }, { ref: TP.ref, direction: 'blocked-by' })).status).toBe(201)
    expect((await call(patchTaskRoute, 'PATCH', `/tasks/${TP2.ref}`, { ref: TP2.ref }, { status: 'done', resolution: `Closed ${WORD}.` })).status).toBe(200)
    const deleted = await call(deleteTaskRoute, 'DELETE', `/tasks/${TP3.ref}?confirm=${TP3.ref}`, { ref: TP3.ref })
    expect(deleted.status).toBe(200)

    // In flight and holding a claim nobody is acting on: context and next both look.
    await q(
      `update tasks set status = 'doing', claimed_by = $2, claimed_at = '2000-01-01', heartbeat_at = '2000-01-01'
        where id = $1`,
      [TP.id, `claude-code · ${emailOf(A)}`],
    )
  })
})

describe('an outsider (C) and an administrator (D) get not_found from every subject route', () => {
  const refsOf = () => [P.ref, String(P.number), `s-${P.number}`, P.id]

  it('answers each hidden subject route exactly as for a subject that does not exist', async () => {
    for (const who of [C, D]) {
      as(who)
      for (const ref of refsOf()) {
        const cases: [string, Promise<Result>][] = [
          ['GET subject', call(showSubjectRoute, 'GET', `/subjects/${ref}`, { ref })],
          ['PATCH subject', call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { title: 'hijacked' })],
          ['PATCH visibility', call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { visibility: 'lab' })],
          ['GET notes', call(subjectNotesRoute, 'GET', `/subjects/${ref}/notes`, { ref })],
          ['POST note', call(addSubjectNoteRoute, 'POST', `/subjects/${ref}/notes`, { ref }, { note: 'x' })],
          ['GET todos', call(subjectTodosRoute, 'GET', `/subjects/${ref}/todos`, { ref })],
          ['POST todo', call(addTodoRoute, 'POST', `/subjects/${ref}/todos`, { ref }, { title: 'x' })],
          ['GET human notes', call(humanNotesRoute, 'GET', `/subjects/${ref}/human-notes`, { ref })],
          ['POST human note', call(addHumanNoteRoute, 'POST', `/subjects/${ref}/human-notes`, { ref }, { body: 'x' })],
          ['PATCH human note', call(patchHumanNoteRoute, 'PATCH', `/subjects/${ref}/human-notes/${humanNoteId}`, { ref, id: humanNoteId }, { body: 'x' })],
          ['DELETE human note', call(deleteHumanNoteRoute, 'DELETE', `/subjects/${ref}/human-notes/${humanNoteId}`, { ref, id: humanNoteId })],
          ['GET files', call(subjectFilesRoute, 'GET', `/subjects/${ref}/attachments`, { ref })],
          ['DELETE file', call(deleteSubjectFileRoute, 'DELETE', `/subjects/${ref}/attachments/${subjectFileId}`, { ref, id: subjectFileId })],
          ['GET members', call(membersRoute, 'GET', `/subjects/${ref}/members`, { ref })],
          ['POST member', call(addMemberRoute, 'POST', `/subjects/${ref}/members`, { ref }, { user: 'me' })],
          ['DELETE member', call(removeMemberRoute, 'DELETE', `/subjects/${ref}/members/${who}`, { ref, userId: who })],
          ['POST publish', call(publishRoute, 'POST', `/subjects/${ref}/publish`, { ref })],
        ]
        for (const [what, pending] of cases) {
          const res = await pending
          expect([what, ref, res.status]).toEqual([what, ref, 404])
          expect(res.json).toEqual(missingSubject(ref))
        }
        const file = await upload(uploadSubjectFileRoute, `/subjects/${ref}/attachments`, { ref }, new File(['x'], 'x.txt', { type: 'text/plain' }))
        expect(file.status).toBe(404)
        expect(file.json).toEqual(missingSubject(ref))
      }
    }
  })

  it('refuses a hidden subject as a filter exactly as an unknown one', async () => {
    for (const who of [C, D]) {
      as(who)
      const hidden = await call(projectTasksRoute, 'GET', `/projects/T/tasks?subject=${P.ref}`, { id: 'T' })
      expect(hidden.status).toBe(404)
      expect(hidden.json).toEqual(missingSubject(P.ref))
    }
  })

  it('changed nothing: title, notes, human note and files are as A left them', async () => {
    as(A)
    const shown = await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })
    expect(shown.json.data).toMatchObject({ title: `Private ${WORD}`, visibility: 'private', members: [] })
    const notes = await call(subjectNotesRoute, 'GET', `/subjects/${P.ref}/notes`, { ref: P.ref })
    expect(notes.json.data.map((n: { note: string }) => n.note)).toEqual([`Found ${WORD}.`])
    const human = await call(humanNotesRoute, 'GET', `/subjects/${P.ref}/human-notes`, { ref: P.ref })
    expect(human.json.data.map((n: { body: string }) => n.body)).toEqual([`My ${WORD} note.`])
    const todos = await call(subjectTodosRoute, 'GET', `/subjects/${P.ref}/todos`, { ref: P.ref })
    expect(todos.json.data.map((t: { ref: string }) => t.ref).sort()).toEqual([TP.ref, TP2.ref].sort())
    const files = await call(subjectFilesRoute, 'GET', `/subjects/${P.ref}/attachments`, { ref: P.ref })
    expect(files.json.data.map((f: { id: string }) => f.id)).toEqual([subjectFileId])
  })
})

describe('an outsider (C) and an administrator (D) get not_found from every task route', () => {
  it('answers each hidden todo route exactly as for a task that does not exist', async () => {
    for (const who of [C, D]) {
      as(who)
      for (const ref of [TP.ref, TP.id, TP2.ref]) {
        const cases: [string, Promise<Result>][] = [
          ['GET task', call(showTaskRoute, 'GET', `/tasks/${ref}`, { ref })],
          ['GET digest', call(showTaskRoute, 'GET', `/tasks/${ref}?view=digest`, { ref })],
          ['PATCH task', call(patchTaskRoute, 'PATCH', `/tasks/${ref}`, { ref }, { title: 'hijacked' })],
          ['DELETE task', call(deleteTaskRoute, 'DELETE', `/tasks/${ref}?confirm=${ref}`, { ref })],
          ['GET notes', call(taskNotesRoute, 'GET', `/tasks/${ref}/notes`, { ref })],
          ['POST note', call(addTaskNoteRoute, 'POST', `/tasks/${ref}/notes`, { ref }, { note: 'x' })],
          ['DELETE note', call(deleteTaskNoteRoute, 'DELETE', `/tasks/${ref}/notes/${taskNoteId}`, { ref, id: taskNoteId })],
          ['GET comments', call(commentsRoute, 'GET', `/tasks/${ref}/comments`, { ref })],
          ['POST comment', call(addCommentRoute, 'POST', `/tasks/${ref}/comments`, { ref }, { content: 'x' })],
          ['GET files', call(taskFilesRoute, 'GET', `/tasks/${ref}/attachments`, { ref })],
          ['GET activity', call(taskActivityRoute, 'GET', `/tasks/${ref}/activity`, { ref })],
          ['POST evidence', call(addEvidenceRoute, 'POST', `/tasks/${ref}/activity`, { ref }, { event: 'git_commit', sha: 'abcdef1' })],
          ['GET children', call(childrenRoute, 'GET', `/tasks/${ref}/children`, { ref })],
          ['GET dependencies', call(dependenciesRoute, 'GET', `/tasks/${ref}/dependencies`, { ref })],
          ['POST dependency', call(addDependencyRoute, 'POST', `/tasks/${ref}/dependencies`, { ref }, { ref: TL.ref })],
          ['DELETE dependency', call(removeDependencyRoute, 'DELETE', `/tasks/${ref}/dependencies?ref=${TL.ref}`, { ref })],
          ['GET mentions', call(mentionsRoute, 'GET', `/tasks/${ref}/mentions`, { ref })],
          ['POST claim', call(claimRoute, 'POST', `/tasks/${ref}/claim`, { ref }, {})],
          ['POST release', call(releaseRoute, 'POST', `/tasks/${ref}/release`, { ref }, { force: true })],
          ['POST beat', call(beatRoute, 'POST', `/tasks/${ref}/beat`, { ref }, {})],
          ['POST block', call(blockRoute, 'POST', `/tasks/${ref}/block`, { ref }, { reason: 'x' })],
          ['POST checkpoint', call(checkpointRoute, 'POST', `/tasks/${ref}/checkpoint`, { ref }, { summary: 'x' })],
          ['POST cairn-link', call(cairnLinkRoute, 'POST', `/tasks/${ref}/cairn-link`, { ref }, { cairnRef: 'CAIRN-1', force: true })],
        ]
        for (const [what, pending] of cases) {
          const res = await pending
          expect([what, ref, res.status]).toEqual([what, ref, 404])
          expect(res.json).toMatchObject(missingTask(ref))
        }
        const file = await upload(uploadTaskFileRoute, `/tasks/${ref}/attachments`, { ref }, new File(['x'], 'x.txt', { type: 'text/plain' }))
        expect(file.status).toBe(404)
      }
    }
  })

  it('refuses a hidden todo named in a body exactly as an unknown one', async () => {
    for (const who of [C, D]) {
      as(who)
      const dependency = await call(addDependencyRoute, 'POST', `/tasks/${TL.ref}/dependencies`, { ref: TL.ref }, { ref: TP.ref })
      expect(dependency.status).toBe(404)
      expect(dependency.json).toEqual(missingTask(TP.ref))
      const unlink = await call(removeDependencyRoute, 'DELETE', `/tasks/${TL.ref}/dependencies?ref=${TP.ref}&direction=blocked-by`, { ref: TL.ref })
      expect(unlink.status).toBe(404)
      expect(unlink.json).toEqual(missingTask(TP.ref))
      const duplicate = await call(patchTaskRoute, 'PATCH', `/tasks/${TL.ref}`, { ref: TL.ref }, { duplicateOf: TP.ref })
      expect(duplicate.status).toBe(404)
      expect(duplicate.json).toEqual(missingTask(TP.ref))
      const missingParent = await call(patchTaskRoute, 'PATCH', `/tasks/${TL.ref}`, { ref: TL.ref }, { parentRef: 'T-9999999' })
      const parent = await call(patchTaskRoute, 'PATCH', `/tasks/${TL.ref}`, { ref: TL.ref }, { parentRef: TP.ref })
      expect(parent.status).toBe(missingParent.status)
      expect(parent.json.code).toBe(missingParent.json.code)
      expect(parent.json.error).toBe(`No task ${TP.ref}.`)
    }
  })

  it('does not name the private todo from the lab todo it mentions, hangs under and blocks', async () => {
    for (const who of [C, D]) {
      as(who)
      const mentions = await call(mentionsRoute, 'GET', `/tasks/${TL.ref}/mentions`, { ref: TL.ref })
      expect(mentions.json.data).toEqual({ total: 0, mentions: [] })
      const shown = await call(showTaskRoute, 'GET', `/tasks/${TL.ref}`, { ref: TL.ref })
      expect(shown.status).toBe(200)
      expect(shown.json.data.mentioned_in_total).toBe(0)
      expect(JSON.stringify(shown.json.data)).not.toContain(WORD)
      const digest = await call(showTaskRoute, 'GET', `/tasks/${TL.ref}?view=digest`, { ref: TL.ref })
      expect(digest.json.data).toMatchObject({ mentionedInTotal: 0, mentionedIn: [], children: null })
      expect(JSON.stringify(digest.json.data)).not.toContain(TP.ref)
      const children = await call(childrenRoute, 'GET', `/tasks/${TL.ref}/children`, { ref: TL.ref })
      expect(children.json.data).toEqual({ count: 0, closed: 0, children: [] })
      const deps = await call(dependenciesRoute, 'GET', `/tasks/${TL.ref}/dependencies`, { ref: TL.ref })
      expect(deps.json.data).toEqual([])

      expect(await mentionsOf(TL.id, 10, viewer(who))).toEqual({ total: 0, mentions: [] })
      expect(await listChildren(TL.id, viewer(who))).toEqual([])
      expect(await listRelations(TL.id, viewer(who))).toEqual([])
    }

    // …and A, who can see it, does get all three.
    as(A)
    const mentions = await call(mentionsRoute, 'GET', `/tasks/${TL.ref}/mentions`, { ref: TL.ref })
    expect(mentions.json.data.total).toBe(1)
    expect(mentions.json.data.mentions[0].ref).toBe(TP.ref)
    const children = await call(childrenRoute, 'GET', `/tasks/${TL.ref}/children`, { ref: TL.ref })
    expect(children.json.data.count).toBe(1)
    const deps = await call(dependenciesRoute, 'GET', `/tasks/${TL.ref}/dependencies`, { ref: TL.ref })
    expect(deps.json.data.map((d: { ref: string }) => d.ref)).toEqual([TP.ref])
    expect((await listChildren(TL.id, viewer(A))).map((c) => c.id)).toEqual([TP.id])
    expect((await listRelations(TL.id, viewer(A))).map((r) => r.id)).toEqual([TP.id])
  })

  it('left the private todo exactly as A wrote it', async () => {
    as(A)
    const shown = await call(showTaskRoute, 'GET', `/tasks/${TP.ref}`, { ref: TP.ref })
    expect(shown.status).toBe(200)
    expect(shown.json.data).toMatchObject({
      title: `${WORD} private todo`,
      labels: [LABEL],
      blocked_reason: null,
      cairn_ref: null,
      subject: { ref: P.ref, visibility: 'private' },
    })
    const notes = await call(taskNotesRoute, 'GET', `/tasks/${TP.ref}/notes`, { ref: TP.ref })
    expect(notes.json.data.length ?? notes.json.data.notes?.length).toBe(1)
    const comments = await call(commentsRoute, 'GET', `/tasks/${TP.ref}/comments`, { ref: TP.ref })
    expect((comments.json.data.comments ?? comments.json.data).length).toBe(1)
    const files = await call(taskFilesRoute, 'GET', `/tasks/${TP.ref}/attachments`, { ref: TP.ref })
    expect((files.json.data.attachments ?? files.json.data).length).toBe(1)
  })
})

describe('files by id', () => {
  it('answers a hidden file by id, and its content URL, exactly as a missing one', async () => {
    const missing = randomUUID()
    for (const who of [C, D]) {
      as(who)
      const none = await call(attachmentRoute, 'GET', `/attachments/${missing}`, { id: missing })
      for (const id of [subjectFileId, taskFileId]) {
        const shown = await call(attachmentRoute, 'GET', `/attachments/${id}`, { id })
        expect(shown.status).toBe(404)
        expect(shown.json).toEqual(none.json)
        const content = await call(contentRoute, 'GET', `/attachments/${id}/content`, { id })
        expect(content.status).toBe(404)
        expect(content.location).toBeNull()
      }
      const deleted = await call(deleteAttachmentRoute, 'DELETE', `/attachments/${taskFileId}`, { id: taskFileId })
      expect(deleted.status).toBe(404)
    }

    as(A)
    for (const id of [subjectFileId, taskFileId]) {
      expect((await call(attachmentRoute, 'GET', `/attachments/${id}`, { id })).status).toBe(200)
      const content = await call(contentRoute, 'GET', `/attachments/${id}/content`, { id })
      expect(content.status).toBe(302)
    }
  })
})

describe('lists, search, activity and briefings', () => {
  it('leaves the subject off the board, the list and the page loaders', async () => {
    for (const who of [C, D]) {
      as(who)
      const board = await call(listSubjectsRoute, 'GET', '/subjects?archived=include', {})
      expect(board.json.data.map((s: { id: string }) => s.id)).not.toContain(P.id)
      const searched = await call(listSubjectsRoute, 'GET', `/subjects?q=${WORD}`, {})
      expect(searched.json.data).toEqual([])
      const inProject = await call(listSubjectsRoute, 'GET', `/subjects?project=${projectName}`, {})
      expect(inProject.json.data).toEqual([])

      const v = viewer(who)
      expect((await listSubjects({ archived: 'include' }, v)).map((s) => s.id)).not.toContain(P.id)
      expect(await getSubject(P.number, v)).toBeNull()
      expect(await listSubjectNotes(P.id, v)).toEqual([])
      expect(await listSubjectTodos(P.id, v)).toEqual([])
      expect(await listSubjectHumanNotes(P.id, v)).toEqual([])
      expect(await listSubjectAttachments(P.id, v)).toEqual([])
      expect(await listLabTodos({ subject: P.id, includeClosed: true }, v)).toEqual([])
      expect((await listLabTodos({ includeClosed: true, limit: 2000 }, v)).map((t) => t.id)).not.toContain(TP.id)
      expect(await listLabTodos({ project: projectName, includeClosed: true }, v)).toEqual([])

      expect(await getTask(who, 'T', Number(TP.ref.slice(2)), v)).toBeNull()
      expect(await getDuplicateOf(TP.id, v)).toBeNull()
      expect(await getParent(TP.id, v)).toBeNull()
      expect(await listNotes(TP.id, v)).toEqual([])
      expect(await listComments(TP.id, v)).toEqual([])
      expect(await listAttachments(TP.id, v)).toEqual([])
      expect(await listTaskAttachments(TP.id, v)).toEqual([])
      expect(await listActivity(TP.id, v)).toEqual([])
      expect(await listAlsoProjects(TP.id, v)).toEqual([])
      expect(await listChildren(TP.id, v)).toEqual([])
      expect(await listRelations(TP.id, v)).toEqual([])

      const everything = await listBoardTasks(who, { includeClosed: true }, v)
      expect(everything.tasks.map((t) => t.id)).not.toContain(TP.id)
      expect(everything.tasks.map((t) => t.id)).not.toContain(TP2.id)
      const all = await listAllTasks(who, { includeClosed: true }, v)
      expect([...all.tasks, ...all.recentlyClosed].map((t) => t.id)).not.toContain(TP.id)
      expect(all.recentlyClosed.map((t) => t.id)).not.toContain(TP2.id)
      const page = await listTasks(tProjectId, { includeClosed: true }, v)
      expect([...page.tasks, ...page.recentlyClosed].map((t) => t.id)).not.toContain(TP.id)

      const api = await call(projectTasksRoute, 'GET', '/projects/T/tasks?limit=200', { id: 'T' })
      expect(api.json.data.tasks.map((t: { id: string }) => t.id)).not.toContain(TP.id)
      const byProject = await call(projectTasksRoute, 'GET', `/projects/T/tasks?project=${projectName}`, { id: 'T' })
      expect(byProject.json.data).toMatchObject({ count: 0, tasks: [] })
    }

    // The loaders do return it to its owner: the filter, not a broken query.
    const a = viewer(A)
    expect(await getSubject(P.number, a)).toMatchObject({ id: P.id, visibility: 'private' })
    expect((await getTask(A, 'T', Number(TP.ref.slice(2)), a))?.subject).toMatchObject({ ref: P.ref, visibility: 'private' })
    expect((await listBoardTasks(A, { includeClosed: true }, a)).tasks.map((t) => t.id)).toContain(TP.id)
    expect((await listLabTodos({ subject: P.id, includeClosed: true }, a)).map((t) => t.id).sort()).toEqual([TP.id, TP2.id].sort())
    expect((await listLabTodos({ subject: P.id }, a))[0]?.subject).toMatchObject({ ref: P.ref, visibility: 'private' })
    expect((await listNotes(TP.id, a)).length).toBe(1)
  })

  it('reports the same counts to C as before the subject existed; A sees its own', async () => {
    const after = await countsFor(C)
    expect(after).toEqual(before)
    expect(after.labProject).toBe(0)
    expect(after.label).toBeNull()

    const d = await countsFor(D)
    expect(d.labProject).toBe(0)
    expect(d.label).toBeNull()
    expect(d.brief).toEqual(after.brief)

    const a = await countsFor(A)
    expect(a.labProject).toBe(1)
    expect(a.label).not.toBeNull()
    expect(a.brief[P.stage]).toBe((after.brief[P.stage] ?? 0) + 1)
    expect(a.mine).toContain(P.id)
    expect(after.mine).not.toContain(P.id)
    // TP (open) and TP2 (closed); TP3 is gone.
    expect(a.tasksCount).toBe(after.tasksCount! + 2)
    expect(a.taskCount).toBe(after.taskCount! + 2)
    expect(a.boardTotal).toBe(after.boardTotal + 2)
    expect(a.boardClosedHidden).toBe(after.boardClosedHidden + 1)
    expect(a.allClosedHidden).toBe(after.allClosedHidden + 1)
    expect(a.pageTotal).toBe(after.pageTotal! + 2)
    expect(a.pageClosedHidden).toBe(after.pageClosedHidden! + 1)
    expect(a.considered).toBe(after.considered! + 1)
  })

  it('finds nothing of it in search, by word or by ref', async () => {
    for (const who of [C, D]) {
      as(who)
      for (const query of [WORD, P.ref, TP.ref, TP2.ref]) {
        const unified = await call(searchRoute, 'GET', `/search?q=${encodeURIComponent(query)}`, {})
        expect(unified.status).toBe(200)
        const refs = unified.json.data.results.map((r: { ref: string }) => r.ref)
        expect(refs).not.toContain(P.ref)
        expect(refs).not.toContain(TP.ref)
        expect(refs).not.toContain(TP2.ref)
        expect(JSON.stringify(unified.json.data.results)).not.toContain(WORD)
        const tasksOnly = await call(searchRoute, 'GET', `/search?q=${encodeURIComponent(query)}&tasksOnly=true`, {})
        expect(tasksOnly.json.data.results.map((r: { ref: string }) => r.ref)).not.toContain(TP.ref)
        expect(JSON.stringify(tasksOnly.json.data.results)).not.toContain(WORD)
      }
      const word = await call(searchRoute, 'GET', `/search?q=${WORD}`, {})
      expect(word.json.data.count).toBe(0)
    }

    as(A)
    const found = await call(searchRoute, 'GET', `/search?q=${WORD}`, {})
    const refs = found.json.data.results.map((r: { ref: string }) => r.ref)
    expect(refs).toContain(P.ref)
    expect(refs).toContain(TP.ref)
  })

  it('keeps it out of the activity feed, deleted todo included', async () => {
    const hiddenRefs = [P.ref, TP.ref, TP2.ref, TP3.ref]
    for (const who of [C, D]) {
      as(who)
      const feed = await call(activityRoute, 'GET', '/activity?limit=200', {})
      expect(feed.status).toBe(200)
      const rows = feed.json.data.results as { ref: string; title: string; detail: string | null }[]
      expect(rows.filter((r) => hiddenRefs.includes(r.ref))).toEqual([])
      expect(JSON.stringify(rows)).not.toContain(WORD)
      const scoped = await call(activityRoute, 'GET', '/activity?limit=200&project=T', {})
      expect(JSON.stringify(scoped.json.data.results)).not.toContain(WORD)
      expect(JSON.stringify(rows)).not.toContain(`"${TP.ref}"`)

      // The lab todo's own history: the dependency on the private todo is
      // recorded without naming it.
      const tl = await call(taskActivityRoute, 'GET', `/tasks/${TL.ref}/activity`, { ref: TL.ref })
      expect(tl.status).toBe(200)
      expect(JSON.stringify(tl.json.data)).not.toContain(`"${TP.ref}"`)
      expect(JSON.stringify(await listActivity(TL.id, viewer(who)))).not.toContain(`"${TP.ref}"`)
    }

    as(A)
    const feed = await call(activityRoute, 'GET', '/activity?limit=200', {})
    const refs = (feed.json.data.results as { ref: string }[]).map((r) => r.ref)
    expect(refs).toContain(TP.ref)
    // …where the private todo's own history carries the link, the other way round.
    const tp = await listActivity(TP.id, viewer(A))
    expect(tp.find((e) => e.event === 'dependency_added')?.data).toEqual({ other: TL.ref, direction: 'blocks' })
    const tl = await listActivity(TL.id, viewer(A))
    expect(tl.find((e) => e.event === 'dependency_added')?.data).toEqual({ other: null, direction: 'blocked-by' })
  })

  it('leaves it out of the session briefing, next and reconcile', async () => {
    for (const who of [C, D]) {
      as(who)
      const context = await call(contextRoute, 'GET', '/context?project=T&scope=project', {})
      expect(context.status).toBe(200)
      expect(JSON.stringify(context.json.data)).not.toContain(TP.ref)
      expect(JSON.stringify(context.json.data)).not.toContain(WORD)
      const everywhere = await call(contextRoute, 'GET', '/context', {})
      expect(JSON.stringify(everywhere.json.data)).not.toContain(WORD)

      const next = await call(nextRoute, 'GET', '/next?project=T&limit=20', {})
      expect(JSON.stringify(next.json.data)).not.toContain(TP.ref)
      expect(JSON.stringify(next.json.data)).not.toContain(WORD)

      as(who, 'agent')
      const reconciled = await call(reconcileRoute, 'POST', '/reconcile', {}, { dryRun: true })
      expect(JSON.stringify(reconciled.json.data)).not.toContain(TP.ref)
    }

    // Positive control: the owner's briefing does name it.
    as(A)
    const context = await call(contextRoute, 'GET', '/context?project=T&scope=project', {})
    expect(context.json.data.inFlight.map((t: { ref: string }) => t.ref)).toContain(TP.ref)
    expect(context.json.data.staleClaims.map((t: { ref: string }) => t.ref)).toContain(TP.ref)
  })

  it('does not move C\'s live-update pulse when A writes on the private todo', async () => {
    const c = await pulse(C)
    const d = await pulse(D)
    const a = await pulse(A)
    as(A)
    expect((await call(addCommentRoute, 'POST', `/tasks/${TP.ref}/comments`, { ref: TP.ref }, { content: 'Pulse check.' })).status).toBe(201)
    expect((await call(addHumanNoteRoute, 'POST', `/subjects/${P.ref}/human-notes`, { ref: P.ref }, { body: 'Pulse check.' })).status).toBe(201)
    expect(await pulse(C)).toBe(c)
    expect(await pulse(D)).toBe(d)
    expect(await pulse(A)).not.toBe(a)
  })
})

describe('sharing with a member (B)', () => {
  it('keeps B out until added', async () => {
    as(B)
    expect((await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })).status).toBe(404)
    expect((await call(showTaskRoute, 'GET', `/tasks/${TP.ref}`, { ref: TP.ref })).status).toBe(404)
  })

  it('lets only the owner share, and sharing makes it a members subject with a log note', async () => {
    as(C)
    expect((await call(addMemberRoute, 'POST', `/subjects/${P.ref}/members`, { ref: P.ref }, { user: emailOf(B) })).status).toBe(404)

    as(A)
    const unknown = await call(addMemberRoute, 'POST', `/subjects/${P.ref}/members`, { ref: P.ref }, { user: 'nobody-at-all@example.test' })
    expect(unknown.status).toBe(404)
    const self = await call(addMemberRoute, 'POST', `/subjects/${P.ref}/members`, { ref: P.ref }, { user: 'me' })
    expect(self.status).toBe(400)

    const added = await call(addMemberRoute, 'POST', `/subjects/${P.ref}/members`, { ref: P.ref }, { user: emailOf(B) })
    expect(added.status).toBe(201)
    expect(added.json.data).toMatchObject({ visibility: 'members', members: [{ id: B, name: emailOf(B) }] })

    const notes = await call(subjectNotesRoute, 'GET', `/subjects/${P.ref}/notes?kind=visibility`, { ref: P.ref })
    expect(notes.json.data.map((n: { note: string }) => n.note)).toEqual([`shared with ${emailOf(B)}`])
  })

  it('shows B the subject, its todos, its files and its counts', async () => {
    as(B)
    expect((await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })).status).toBe(200)
    expect((await call(showTaskRoute, 'GET', `/tasks/${TP.ref}`, { ref: TP.ref })).json.data.subject).toMatchObject({ visibility: 'members' })
    expect((await call(attachmentRoute, 'GET', `/attachments/${subjectFileId}`, { id: subjectFileId })).status).toBe(200)
    expect((await call(contentRoute, 'GET', `/attachments/${taskFileId}/content`, { id: taskFileId })).status).toBe(302)
    const members = await call(membersRoute, 'GET', `/subjects/${P.ref}/members`, { ref: P.ref })
    expect(members.json.data).toMatchObject({ visibility: 'members', owner: { id: A }, members: [{ id: B }] })
    const found = await call(searchRoute, 'GET', `/search?q=${WORD}`, {})
    expect(found.json.data.results.map((r: { ref: string }) => r.ref)).toContain(P.ref)
    const mentions = await call(mentionsRoute, 'GET', `/tasks/${TL.ref}/mentions`, { ref: TL.ref })
    expect(mentions.json.data.total).toBe(1)
    expect((await countsFor(B)).labProject).toBe(1)
    expect((await listBoardTasks(B, {}, viewer(B))).tasks.map((t) => t.id)).toContain(TP.id)
  })

  it('lets B edit and work on it, but not decide who sees it', async () => {
    as(B)
    const edited = await call(patchSubjectRoute, 'PATCH', `/subjects/${P.ref}`, { ref: P.ref }, { body: `Edited by B about ${WORD}.` })
    expect(edited.status).toBe(200)
    expect((await call(addTaskNoteRoute, 'POST', `/tasks/${TP.ref}/notes`, { ref: TP.ref }, { note: 'B was here.' })).status).toBe(201)

    for (const [what, pending] of [
      ['private', call(patchSubjectRoute, 'PATCH', `/subjects/${P.ref}`, { ref: P.ref }, { visibility: 'private' })],
      ['lab', call(patchSubjectRoute, 'PATCH', `/subjects/${P.ref}`, { ref: P.ref }, { visibility: 'lab' })],
      ['owner', call(patchSubjectRoute, 'PATCH', `/subjects/${P.ref}`, { ref: P.ref }, { owner: 'me' })],
      ['share', call(addMemberRoute, 'POST', `/subjects/${P.ref}/members`, { ref: P.ref }, { user: emailOf(C) })],
      ['publish', call(publishRoute, 'POST', `/subjects/${P.ref}/publish`, { ref: P.ref })],
    ] as const) {
      const res = await pending
      expect([what, res.status, res.json.code]).toEqual([what, 403, 'forbidden'])
    }
    as(A)
    const shown = await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })
    expect(shown.json.data).toMatchObject({ visibility: 'members', owner: { id: A }, members: [{ id: B }] })
  })

  it('still keeps C and D out', async () => {
    for (const who of [C, D]) {
      as(who)
      expect((await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })).status).toBe(404)
      expect((await call(showTaskRoute, 'GET', `/tasks/${TP.ref}`, { ref: TP.ref })).status).toBe(404)
      expect((await call(searchRoute, 'GET', `/search?q=${WORD}`, {})).json.data.count).toBe(0)
    }
  })

  it('lets a member leave, and the owner remove and re-add them', async () => {
    as(B)
    const left = await call(removeMemberRoute, 'DELETE', `/subjects/${P.ref}/members/me`, { ref: P.ref, userId: 'me' })
    expect(left.status).toBe(200)
    expect(left.json.data).toEqual({ ref: P.ref, left: true })
    expect((await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })).status).toBe(404)

    as(A)
    expect((await call(addMemberRoute, 'POST', `/subjects/${P.ref}/members`, { ref: P.ref }, { user: B })).status).toBe(201)
    const removed = await call(removeMemberRoute, 'DELETE', `/subjects/${P.ref}/members/${B}`, { ref: P.ref, userId: B })
    expect(removed.status).toBe(200)
    expect(removed.json.data.members).toEqual([])
    const again = await call(removeMemberRoute, 'DELETE', `/subjects/${P.ref}/members/${B}`, { ref: P.ref, userId: B })
    expect(again.status).toBe(404)
    expect((await call(addMemberRoute, 'POST', `/subjects/${P.ref}/members`, { ref: P.ref }, { user: B })).status).toBe(201)
  })
})

describe('the administrator exception', () => {
  it('shows D the subject only while its owner is deactivated, and lets D manage it then', async () => {
    await q(`update app_users set banned_until = now() + interval '1 day' where id = $1`, [A])
    try {
      as(D)
      const shown = await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })
      expect(shown.status).toBe(200)
      expect((await call(showTaskRoute, 'GET', `/tasks/${TP.ref}`, { ref: TP.ref })).status).toBe(200)
      const made = await call(patchSubjectRoute, 'PATCH', `/subjects/${P.ref}`, { ref: P.ref }, { visibility: 'private' })
      expect(made.status).toBe(200)
      expect(made.json.data.visibility).toBe('private')
      const shared = await call(patchSubjectRoute, 'PATCH', `/subjects/${P.ref}`, { ref: P.ref }, { visibility: 'members' })
      expect(shared.status).toBe(200)

      // Not a member: the exception is for admins only.
      as(C)
      expect((await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })).status).toBe(404)
    } finally {
      await q('update app_users set banned_until = null where id = $1', [A])
    }
    as(D)
    expect((await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })).status).toBe(404)
  })
})

describe('pushing a todo whose subject is not in the lab', () => {
  it('says the subject\'s visibility on the todo and refuses the link without force', async () => {
    as(A)
    const shown = await call(showTaskRoute, 'GET', `/tasks/${TP.ref}`, { ref: TP.ref })
    expect(shown.json.data.subject).toMatchObject({ ref: P.ref, visibility: 'members' })

    const refused = await call(cairnLinkRoute, 'POST', `/tasks/${TP.ref}/cairn-link`, { ref: TP.ref }, { cairnRef: 'CAIRN-901' })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ code: 'subject_not_published', subject: P.ref, visibility: 'members' })
    expect((await q('select cairn_ref from tasks where id = $1', [TP.id])).rows[0].cairn_ref).toBeNull()

    const forced = await call(cairnLinkRoute, 'POST', `/tasks/${TP.ref}/cairn-link`, { ref: TP.ref }, { cairnRef: 'CAIRN-901', force: true })
    expect(forced.status).toBe(200)
    expect(forced.json.data.cairn_ref).toBe('CAIRN-901')

    // A lab todo needs no force.
    const lab = await call(cairnLinkRoute, 'POST', `/tasks/${TL.ref}/cairn-link`, { ref: TL.ref }, { cairnRef: 'CAIRN-902' })
    expect(lab.status).toBe(200)
  })

  it('syncs and reports the private todo to those who see it, and to nobody else', async () => {
    await q('delete from cairn_connection where id')
    await q(
      `insert into cairn_connection (id, url, api_key, api_key_plaintext, updated_at)
       values (true, 'https://cairn.example.test', 'sk_test_visibility_1234', true, now())`,
    )
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ success: true, data: { status: 'todo' } }), { status: 200 }))

    as(C)
    const outsider = await call(cairnSyncRoute, 'POST', '/integrations/cairn/sync')
    expect(outsider.status).toBe(200)
    const outsiderRefs = outsider.json.data.results.map((r: { ref: string }) => r.ref)
    expect(outsiderRefs).toContain(TL.ref)
    expect(outsiderRefs).not.toContain(TP.ref)
    expect(JSON.stringify(outsider.json.data)).not.toContain('CAIRN-901')

    as(A)
    const owner = await call(cairnSyncRoute, 'POST', '/integrations/cairn/sync')
    expect(owner.json.data.results.map((r: { ref: string }) => r.ref)).toContain(TP.ref)
    expect(owner.json.data.checked).toBe(outsider.json.data.checked + 1)
    vi.unstubAllGlobals()
  })
})

describe('publishing', () => {
  it('is the owner\'s alone, one-way, and logged', async () => {
    as(A)
    const published = await call(publishRoute, 'POST', `/subjects/${P.ref}/publish`, { ref: P.ref })
    expect(published.status).toBe(200)
    expect(published.json.data).toMatchObject({ visibility: 'lab', members: [] })

    const again = await call(publishRoute, 'POST', `/subjects/${P.ref}/publish`, { ref: P.ref })
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('already_published')
    for (const visibility of ['private', 'members']) {
      const back = await call(patchSubjectRoute, 'PATCH', `/subjects/${P.ref}`, { ref: P.ref }, { visibility })
      expect(back.status).toBe(409)
      expect(back.json.code).toBe('already_published')
    }
    const share = await call(addMemberRoute, 'POST', `/subjects/${P.ref}/members`, { ref: P.ref }, { user: C })
    expect(share.status).toBe(409)
    expect(share.json.code).toBe('already_published')

    const notes = await call(subjectNotesRoute, 'GET', `/subjects/${P.ref}/notes?kind=visibility`, { ref: P.ref })
    const log = notes.json.data.map((n: { note: string }) => n.note)
    expect(log[0]).toBe('published to the lab')
    expect(log).toContain('made private')
    expect(log).toContain(`no longer shared with ${emailOf(B)}`)
  })

  it('shows it to everyone from then on', async () => {
    for (const who of [C, D]) {
      as(who)
      expect((await call(showSubjectRoute, 'GET', `/subjects/${P.ref}`, { ref: P.ref })).status).toBe(200)
      expect((await call(showTaskRoute, 'GET', `/tasks/${TP.ref}`, { ref: TP.ref })).json.data.subject).toMatchObject({ visibility: 'lab' })
      expect((await call(searchRoute, 'GET', `/search?q=${WORD}`, {})).json.data.count).toBeGreaterThan(0)
      expect((await countsFor(who)).labProject).toBe(1)
    }
  })
})

describe('the rules at the edges', () => {
  it('refuses a non-lab subject with no owner, for someone else, or with members it cannot have', async () => {
    as(A)
    const unowned = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `Unowned ${RUN}`, visibility: 'private', owner: null })
    expect(unowned.status).toBe(400)
    expect(unowned.json.code).toBe('owner_required')
    const forOther = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `For B ${RUN}`, visibility: 'private', owner: B })
    expect(forOther.status).toBe(403)
    expect(forOther.json.code).toBe('forbidden')
    const labMembers = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `Lab members ${RUN}`, members: [B] })
    expect(labMembers.status).toBe(400)
    const privateMembers = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `Private members ${RUN}`, visibility: 'private', members: [B] })
    expect(privateMembers.status).toBe(400)
    const bad = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `Bad ${RUN}`, visibility: 'secret' })
    expect(bad.status).toBe(400)
  })

  it('files a members subject with its members, and refuses to strip its owner', async () => {
    as(A)
    const created = await call(createSubjectRoute, 'POST', '/subjects', {}, {
      title: `Shared ${RUN}`,
      visibility: 'members',
      members: [emailOf(B), B, 'me'],
    })
    expect(created.status).toBe(201)
    subjectIds.push(created.json.data.id)
    expect(created.json.data).toMatchObject({ visibility: 'members', members: [{ id: B }] })
    const ref = created.json.data.ref as string

    as(B)
    expect((await call(showSubjectRoute, 'GET', `/subjects/${ref}`, { ref })).status).toBe(200)
    as(C)
    expect((await call(showSubjectRoute, 'GET', `/subjects/${ref}`, { ref })).json).toEqual(missingSubject(ref))

    as(A)
    const stripped = await call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { owner: null })
    expect(stripped.status).toBe(400)
    expect(stripped.json.code).toBe('owner_required')

    // Handing it to B: B owns it, A — no longer owner or member — cannot see it.
    const handed = await call(patchSubjectRoute, 'PATCH', `/subjects/${ref}`, { ref }, { owner: B })
    expect(handed.status).toBe(200)
    expect(handed.json.data).toMatchObject({ owner: { id: B }, members: [] })
    expect((await call(showSubjectRoute, 'GET', `/subjects/${ref}`, { ref })).status).toBe(404)
  })

  it('never lets a caller write a visibility note by hand', async () => {
    as(A)
    const res = await call(addSubjectNoteRoute, 'POST', `/subjects/${L.ref}/notes`, { ref: L.ref }, { note: 'published to the lab', kind: 'visibility' })
    expect(res.status).toBe(400)
  })

  it('refuses members on a lab subject', async () => {
    as(A)
    const res = await call(addMemberRoute, 'POST', `/subjects/${L.ref}/members`, { ref: L.ref }, { user: B })
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('already_published')
  })
})

import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * v0.4 visibility, attacked from the side: the paths the leak suite
 * (subject-visibility.test.ts) does not walk. Each case here was a hole an
 * adversarial review found — an outsider or a non-owner administrator
 * learning about, or changing, a private subject or its todos — and stays as
 * the proof that it is closed.
 *
 * A owns the private subject P (todo TP) and the lab subject L (todos TL,
 * TL2). C is an outsider, D an administrator. Neither may see P.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { admin, pool } from '@/lib/db/client'
import { POST as createSubjectRoute } from '@/app/api/v1/subjects/route'
import { GET as showSubjectRoute } from '@/app/api/v1/subjects/[ref]/route'
import { POST as addTodoRoute } from '@/app/api/v1/subjects/[ref]/todos/route'
import { POST as publishRoute } from '@/app/api/v1/subjects/[ref]/publish/route'
import { GET as showTaskRoute, PATCH as patchTaskRoute } from '@/app/api/v1/tasks/[ref]/route'
import { POST as createProjectRoute } from '@/app/api/v1/projects/route'
import { DELETE as deleteProjectRoute } from '@/app/api/v1/projects/[id]/route'
import { POST as reconcileRoute } from '@/app/api/v1/reconcile/route'
import { getTask } from '@/lib/data'
import { addSubjectMember, resolveSubject, updateSubject } from '@/lib/api/subjects'
import { restrictTo, visibleTasksOr, type Viewer } from '@/lib/api/visibility'
import type { Actor } from '@/lib/api/auth'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')
process.env.CROFT_SECRET_KEY ??= randomBytes(32).toString('hex')

const ORIGIN = 'https://croft.example.test'
const RUN = randomUUID().replace(/[^a-z]/g, '').slice(0, 6)
const WORD = `quokka${RUN}axolotl`
const KEY = `AU${RUN.toUpperCase().slice(0, 6)}`

const A = randomUUID()
const C = randomUUID()
const D = randomUUID()
const E = randomUUID()
const USERS = [A, C, D, E]
const emailOf = (id: string) => `audit-${id.slice(0, 8)}@example.test`

type Role = 'admin' | 'member'
const ROLE: Record<string, Role> = { [A]: 'member', [C]: 'member', [D]: 'admin', [E]: 'member' }
const viewer = (id: string): Viewer => ({ id, role: ROLE[id]! })

const actorFor = (userId: string, agentName?: string) => ({
  userId,
  actorType: agentName ? ('agent' as const) : ('human' as const),
  actorId: agentName ? `${agentName} · ${emailOf(userId)}` : emailOf(userId),
  userDisplayName: emailOf(userId),
  role: ROLE[userId]!,
  rateKey: `audit-${randomUUID()}`,
  sessionId: null,
  agentName,
})
const as = (userId: string, agentName?: string) => {
  auth.actor = actorFor(userId, agentName)
}

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>
type Result = { status: number; json: Record<string, any> }

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
  return { status: response.status, json: text ? JSON.parse(text) : {} }
}

const q = (sql: string, params: unknown[] = []) => pool().query(sql, params)

let todoProjectExisted = false
const subjectIds: string[] = []
const P = { id: '', ref: '' }
const L = { id: '', ref: '' }
const TP = { id: '', ref: '' }
const TL = { id: '', ref: '' }
const TL2 = { id: '', ref: '' }

const fileSubject = async (title: string, visibility?: string) => {
  const res = await call(createSubjectRoute, 'POST', '/subjects', {}, { title, ...(visibility ? { visibility } : {}) })
  expect(res.status).toBe(201)
  subjectIds.push(res.json.data.id)
  return { id: res.json.data.id as string, ref: res.json.data.ref as string }
}

const fileTodo = async (subjectRef: string, title: string) => {
  const res = await call(addTodoRoute, 'POST', `/subjects/${subjectRef}/todos`, { ref: subjectRef }, { title })
  expect(res.status).toBe(201)
  return { id: res.json.data.id as string, ref: res.json.data.ref as string }
}

beforeAll(async () => {
  for (const id of USERS) {
    await q('insert into app_users (id, email, encrypted_password, role) values ($1, $2, $3, $4)', [
      id,
      emailOf(id),
      'not-used',
      ROLE[id],
    ])
  }
  todoProjectExisted = (await q(`select 1 from projects where key = 'T'`)).rowCount === 1

  as(A)
  Object.assign(L, await fileSubject(`Audit lab ${RUN}`))
  Object.assign(TL, await fileTodo(L.ref, `Audit lab todo ${RUN}`))
  Object.assign(TL2, await fileTodo(L.ref, `Audit lab todo two ${RUN}`))
  Object.assign(P, await fileSubject(`Private ${WORD}`, 'private'))
  Object.assign(TP, await fileTodo(P.ref, `${WORD} private todo`))
})

afterAll(async () => {
  if (subjectIds.length) {
    await q('delete from tasks where subject_id = any($1::uuid[])', [subjectIds])
    await q('delete from subjects where id = any($1::uuid[])', [subjectIds])
  }
  await q('delete from projects where key = $1', [KEY])
  if (!todoProjectExisted) await q(`delete from projects where key = 'T' and owner_user_id = any($1::uuid[])`, [USERS])
  await q('delete from app_users where id = any($1::uuid[])', [USERS])
  await pool().end()
})

describe('a lab task that points at a private todo', () => {
  it('does not hand an outsider the private todo\'s id as its parent or original', async () => {
    as(A)
    expect((await call(patchTaskRoute, 'PATCH', `/tasks/${TL.ref}`, { ref: TL.ref }, { parentRef: TP.ref })).status).toBe(200)
    const dup = await call(patchTaskRoute, 'PATCH', `/tasks/${TL2.ref}`, { ref: TL2.ref }, {
      status: 'cancelled',
      resolution: 'Same work as the private one.',
      duplicateOf: TP.ref,
    })
    expect(dup.status).toBe(200)

    // A, who sees both, gets the pointers.
    const own = await call(showTaskRoute, 'GET', `/tasks/${TL.ref}`, { ref: TL.ref })
    expect(own.json.data.parent_id).toBe(TP.id)

    for (const who of [C, D]) {
      as(who)
      const child = await call(showTaskRoute, 'GET', `/tasks/${TL.ref}`, { ref: TL.ref })
      expect(child.status).toBe(200)
      expect(child.json.data.parent_id).toBeNull()
      const copy = await call(showTaskRoute, 'GET', `/tasks/${TL2.ref}`, { ref: TL2.ref })
      expect(copy.status).toBe(200)
      expect(copy.json.data.duplicate_of).toBeNull()
      expect(JSON.stringify([child.json, copy.json])).not.toContain(TP.id)

      // The task page's loader: its row goes to a client component whole.
      const [key, number] = TL.ref.split('-')
      const page = await getTask(who, key!, Number(number), viewer(who))
      expect(page?.parent_id ?? null).toBeNull()
      const [key2, number2] = TL2.ref.split('-')
      const page2 = await getTask(who, key2!, Number(number2), viewer(who))
      expect(page2?.duplicate_of ?? null).toBeNull()
    }
  })
})

describe('deleting a project', () => {
  it('refuses an outsider or an administrator a project holding a private todo they cannot see', async () => {
    as(A)
    const project = await call(createProjectRoute, 'POST', '/projects', {}, { key: KEY, title: `Audit ${RUN}` })
    expect(project.status).toBe(201)
    const moved = await call(patchTaskRoute, 'PATCH', `/tasks/${TP.ref}`, { ref: TP.ref }, { project: KEY })
    expect(moved.status).toBe(200)
    Object.assign(TP, { ref: moved.json.data.ref })
    expect(TP.ref.startsWith(`${KEY}-`)).toBe(true)

    for (const who of [C, D]) {
      as(who)
      const deleted = await call(deleteProjectRoute, 'DELETE', `/projects/${KEY}?confirm=${KEY}`, { id: KEY })
      expect(deleted.status).not.toBe(200)
      expect(JSON.stringify(deleted.json)).not.toContain(WORD)
      expect((await q('select 1 from tasks where id = $1', [TP.id])).rowCount).toBe(1)
    }

    as(A)
    expect((await call(showTaskRoute, 'GET', `/tasks/${TP.ref}`, { ref: TP.ref })).status).toBe(200)
  })
})

describe('changing who sees a subject from a stale read', () => {
  it('never takes a subject out of the lab, however the requests interleave', async () => {
    as(A)
    const S = await fileSubject(`Racing ${RUN}`, 'private')
    // Read before the publish lands, the way a concurrent request would.
    const stale = (await resolveSubject(S.ref, A))!
    expect(stale.visibility).toBe('private')
    expect((await call(publishRoute, 'POST', `/subjects/${S.ref}/publish`, { ref: S.ref })).status).toBe(200)

    const unpublish = await updateSubject(actorFor(A) as Actor, stale, { visibility: 'members' })
    expect(unpublish.ok).toBe(false)
    const share = await addSubjectMember(actorFor(A) as Actor, stale, C)
    expect(share.ok).toBe(false)

    const now = await call(showSubjectRoute, 'GET', `/subjects/${S.ref}`, { ref: S.ref })
    expect(now.json.data).toMatchObject({ visibility: 'lab', members: [] })
    as(E)
    expect((await call(showSubjectRoute, 'GET', `/subjects/${S.ref}`, { ref: S.ref })).status).toBe(200)
  })

  it('does not let a former owner go on deciding who sees it', async () => {
    as(A)
    const S = await fileSubject(`Handed over ${RUN}`, 'private')
    const stale = (await resolveSubject(S.ref, A))!
    // A hands it to E; a request of A's that read it before still arrives.
    const handed = await updateSubject(actorFor(A) as Actor, stale, { owner: E })
    expect(handed.ok).toBe(true)

    const share = await addSubjectMember(actorFor(A) as Actor, stale, C)
    expect(share.ok).toBe(false)
    const publish = await updateSubject(actorFor(A) as Actor, stale, { visibility: 'lab' })
    expect(publish.ok).toBe(false)

    const members = await q('select user_id from subject_members where subject_id = $1', [S.id])
    expect(members.rows).toEqual([])
    as(C)
    expect((await call(showSubjectRoute, 'GET', `/subjects/${S.ref}`, { ref: S.ref })).status).toBe(404)
  })
})

describe('the task filter', () => {
  it('fails closed for a private subject whose first todo lands mid-request', async () => {
    as(A)
    const S = await fileSubject(`Empty so far ${RUN}`, 'private')
    // C's request computes its filter while S has no todos…
    const expression = await visibleTasksOr(C)
    // …and A files one before C's query runs.
    const todo = await fileTodo(S.ref, `${WORD} late todo`)
    const { data } = await restrictTo(admin().from('tasks').select('id'), expression).eq('id', todo.id)
    expect(data ?? []).toEqual([])
  })
})

describe('the maintenance sweep', () => {
  it('names a quiet private todo by ref alone to an administrator\'s maintenance key', async () => {
    // Planted rather than updated: a trigger bumps updated_at on every write,
    // which reads as life. A todo of P's, claimed and quiet since 2000.
    const holder = `claude-code · ${emailOf(A)}`
    const counter = await q(`update projects set task_counter = task_counter + 1 where key = $1 returning id, task_counter`, [KEY])
    const { id: projectId, task_counter: number } = counter.rows[0]
    const quiet = randomUUID()
    await q(
      `insert into tasks (id, project_id, number, title, actor_type, actor_id, status, subject_id, assignee_user_id,
                          claimed_by, claimed_at, heartbeat_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'agent', $5, 'doing', $6, $7, $5, '2000-01-01', '2000-01-01', '2000-01-01', '2000-01-01')`,
      [quiet, projectId, number, `${WORD} quiet todo`, holder, P.id, A],
    )
    const quietRef = `${KEY}-${number}`
    as(D, 'maintenance')
    const swept = await call(reconcileRoute, 'POST', '/reconcile', {}, { dryRun: true })
    expect(swept.status).toBe(200)
    const entry = (swept.json.data.released as { ref: string; holder: string | null }[]).find((r) => r.ref === quietRef)
    expect(entry).toBeDefined()
    expect(entry!.holder).toBeNull()
    expect(JSON.stringify(swept.json.data)).not.toContain(emailOf(A))
    expect(JSON.stringify(swept.json.data)).not.toContain(WORD)
  })
})

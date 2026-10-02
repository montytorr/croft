import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Deleting a subject (CROFT-21), through the real route handlers and a real
 * database: the owner, and an administrator only for a lab subject; the ref
 * repeated to confirm; and nothing left behind — no todo detached into
 * public view, no stored file without a row.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { POST as createSubjectRoute } from '@/app/api/v1/subjects/route'
import { DELETE as deleteSubjectRoute, GET as getSubjectRoute } from '@/app/api/v1/subjects/[ref]/route'
import { POST as addTodoRoute } from '@/app/api/v1/subjects/[ref]/todos/route'
import { POST as uploadSubjectFileRoute } from '@/app/api/v1/subjects/[ref]/attachments/route'
import { POST as uploadTaskFileRoute } from '@/app/api/v1/tasks/[ref]/attachments/route'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://croft.example.test'
const ownerId = randomUUID()
const adminId = randomUUID()
const memberId = randomUUID()
const RUN = randomUUID().slice(0, 8)

type Role = 'admin' | 'member'
const as = (userId: string, role: Role = 'member') => {
  auth.actor = {
    userId,
    actorType: 'human',
    actorId: `delete-${userId.slice(0, 6)}@example.test`,
    userDisplayName: `Delete ${userId.slice(0, 6)}`,
    role,
    rateKey: `delete-${randomUUID()}`,
    sessionId: null,
  }
}

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>

const call = async <P extends Record<string, string>>(handler: Handler<P>, method: string, path: string, params: P, body?: unknown) => {
  const response = await handler(
    new Request(`${ORIGIN}/api/v1${path}`, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', authorization: 'Bearer test' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  )
  return { status: response.status, json: (await response.json()) as Record<string, any> }
}

const upload = async <P extends Record<string, string>>(handler: Handler<P>, path: string, params: P, name: string) => {
  const form = new FormData()
  form.append('file', new File([`notes for ${name}`], name, { type: 'text/plain' }))
  const response = await handler(
    new Request(`${ORIGIN}/api/v1${path}`, { method: 'POST', headers: { authorization: 'Bearer test' }, body: form }),
    { params: Promise.resolve(params) },
  )
  return { status: response.status, json: (await response.json()) as Record<string, any> }
}

const remove = (ref: string, confirm?: string) =>
  call(deleteSubjectRoute, 'DELETE', `/subjects/${ref}${confirm === undefined ? '' : `?confirm=${confirm}`}`, { ref })

const file = async (subject: { title: string; visibility: 'private' | 'members' | 'lab' }) => {
  const created = await call(createSubjectRoute, 'POST', '/subjects', {}, { ...subject, owner: 'me' })
  expect(created.status).toBe(201)
  subjectIds.push(created.json.data.id)
  return created.json.data as { id: string; ref: string }
}

const count = async (sql: string, params: unknown[]) => Number((await pool().query(sql, params)).rows[0].count)
const exists = async (path: string) => access(path).then(() => true, () => false)

let attachmentDir = ''
let todoProjectExisted = false
const subjectIds: string[] = []

beforeAll(async () => {
  attachmentDir = await mkdtemp(join(tmpdir(), 'croft-subject-delete-'))
  process.env.CROFT_ATTACHMENT_DIR = attachmentDir
  process.env.CROFT_ATTACHMENT_SIGNING_KEY ??= 'integration-signing-key-with-enough-entropy'
  for (const [id, role] of [[ownerId, 'member'], [adminId, 'admin'], [memberId, 'member']] as const) {
    await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
      id,
      `delete-${role}-${id}@example.test`,
      'not-used',
      role,
    ])
  }
  todoProjectExisted = (await pool().query(`select 1 from projects where key = 'T'`)).rowCount === 1
})

afterAll(async () => {
  await pool().query('delete from tasks where subject_id = any($1::uuid[])', [subjectIds])
  await pool().query('delete from subjects where id = any($1::uuid[])', [subjectIds])
  if (!todoProjectExisted) {
    await pool().query(`delete from projects where key = 'T' and owner_user_id = any($1::uuid[])`, [[ownerId, adminId, memberId]])
  }
  await pool().query('delete from app_users where id = any($1::uuid[])', [[ownerId, adminId, memberId]])
  await pool().end()
  await rm(attachmentDir, { recursive: true, force: true })
})

describe('deleting a subject', () => {
  it('takes its todos, sub-todos, log and stored files with it', async () => {
    as(ownerId)
    const subject = await file({ title: `Doomed ${RUN}`, visibility: 'private' })
    const todo = await call(addTodoRoute, 'POST', `/subjects/${subject.ref}/todos`, { ref: subject.ref }, { title: `Todo ${RUN}` })
    const sub = await call(addTodoRoute, 'POST', `/subjects/${subject.ref}/todos`, { ref: subject.ref }, { title: `Sub ${RUN}` })
    expect([todo.status, sub.status]).toEqual([201, 201])
    // A sub-todo that lost its subject link is still the subject's: it goes too,
    // rather than surviving as a task with no subject, which everyone can see.
    await pool().query('update tasks set subject_id = null, parent_id = $1 where id = $2', [todo.json.data.id, sub.json.data.id])

    const subjectFile = await upload(uploadSubjectFileRoute, `/subjects/${subject.ref}/attachments`, { ref: subject.ref }, 'plan.txt')
    const todoFile = await upload(uploadTaskFileRoute, `/tasks/${todo.json.data.ref}/attachments`, { ref: todo.json.data.ref }, 'bench.txt')
    expect([subjectFile.status, todoFile.status]).toEqual([201, 201])
    const paths = (
      await pool().query(
        `select storage_path from subject_attachments where subject_id = $1
         union all select storage_path from task_attachments where task_id = $2`,
        [subject.id, todo.json.data.id],
      )
    ).rows.map((r) => join(attachmentDir, r.storage_path as string))
    expect(paths).toHaveLength(2)
    for (const path of paths) expect(await exists(path)).toBe(true)

    const deleted = await remove(subject.ref, subject.ref)
    expect(deleted.status).toBe(200)
    expect(deleted.json.data).toEqual({ deleted: true, ref: subject.ref, id: subject.id, todosDeleted: 2, attachmentsRemoved: 2 })

    expect(await count('select count(*) from subjects where id = $1', [subject.id])).toBe(0)
    expect(await count('select count(*) from tasks where id = any($1::uuid[])', [[todo.json.data.id, sub.json.data.id]])).toBe(0)
    expect(await count('select count(*) from subject_notes where subject_id = $1', [subject.id])).toBe(0)
    for (const path of paths) expect(await exists(path)).toBe(false)
    expect((await call(getSubjectRoute, 'GET', `/subjects/${subject.ref}`, { ref: subject.ref })).status).toBe(404)
  })

  it('asks for the ref to be repeated, and deletes nothing without it', async () => {
    as(ownerId)
    const subject = await file({ title: `Kept ${RUN}`, visibility: 'lab' })
    for (const confirm of [undefined, 'S-0']) {
      const refused = await remove(subject.ref, confirm)
      expect(refused.status).toBe(400)
      expect(refused.json.code).toBe('validation_failed')
      expect(refused.json.requiresConfirmation).toBe(subject.ref)
    }
    expect(await count('select count(*) from subjects where id = $1', [subject.id])).toBe(1)
  })

  it('refuses a member who does not own it, before asking to confirm', async () => {
    as(ownerId)
    const subject = await file({ title: `Not yours ${RUN}`, visibility: 'lab' })
    as(memberId)
    const refused = await remove(subject.ref)
    expect(refused.status).toBe(403)
    expect(refused.json.code).toBe('forbidden')
    expect(await count('select count(*) from subjects where id = $1', [subject.id])).toBe(1)
  })

  it('lets an administrator delete a lab subject', async () => {
    as(ownerId)
    const subject = await file({ title: `Moderated ${RUN}`, visibility: 'lab' })
    as(adminId, 'admin')
    expect((await remove(subject.ref, subject.ref)).status).toBe(200)
    expect(await count('select count(*) from subjects where id = $1', [subject.id])).toBe(0)
  })

  it('does not let an administrator delete a subject outside the lab', async () => {
    as(ownerId)
    const hidden = await file({ title: `Mine alone ${RUN}`, visibility: 'private' })
    const shared = await file({ title: `Ours ${RUN}`, visibility: 'members' })
    await pool().query('insert into subject_members (subject_id, user_id) values ($1, $2)', [shared.id, adminId])

    as(adminId, 'admin')
    // Private: the administrator cannot see it, so it answers as nothing does.
    expect((await remove(hidden.ref, hidden.ref)).status).toBe(404)
    // Members: the administrator sees it as a member, and still may not delete it.
    const refused = await remove(shared.ref, shared.ref)
    expect(refused.status).toBe(403)
    expect(await count('select count(*) from subjects where id = any($1::uuid[])', [[hidden.id, shared.id]])).toBe(2)
  })
})

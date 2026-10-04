import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 0.3's additions to a subject, through the real route handlers and a real
 * database: people's notes (author-only edits), files on a subject and on a
 * todo (HTML included, only ever served sandboxed), the stable content URL
 * markdown embeds, and todo lists that carry their subject.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => auth.actor }
})

import { pool } from '@/lib/db/client'
import { POST as createSubjectRoute } from '@/app/api/v1/subjects/route'
import { POST as addTodoRoute } from '@/app/api/v1/subjects/[ref]/todos/route'
import { GET as listHumanNotesRoute, POST as addHumanNoteRoute } from '@/app/api/v1/subjects/[ref]/human-notes/route'
import { DELETE as deleteHumanNoteRoute, PATCH as patchHumanNoteRoute } from '@/app/api/v1/subjects/[ref]/human-notes/[id]/route'
import { GET as listSubjectFilesRoute, POST as uploadSubjectFileRoute } from '@/app/api/v1/subjects/[ref]/attachments/route'
import { DELETE as deleteSubjectFileRoute } from '@/app/api/v1/subjects/[ref]/attachments/[id]/route'
import { GET as contentRoute } from '@/app/api/v1/attachments/[id]/content/route'
import { GET as attachmentRoute } from '@/app/api/v1/attachments/[id]/route'
import { GET as listTaskFilesRoute, POST as uploadTaskFileRoute } from '@/app/api/v1/tasks/[ref]/attachments/route'
import { GET as listProjectTasksRoute } from '@/app/api/v1/projects/[id]/tasks/route'
import { POST as createLabProjectRoute } from '@/app/api/v1/lab-projects/route'
import { GET as filesRoute } from '@/app/api/files/route'
import { listLabTodos, listSubjectAttachments, listSubjectHumanNotes } from '@/lib/lab/data'
import { listBoardTasks } from '@/lib/board-data'
import { listTaskAttachments } from '@/lib/data'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://croft.example.test'
const adminId = randomUUID()
const memberId = randomUUID()
const otherId = randomUUID()
const RUN = randomUUID().slice(0, 8)

type Role = 'admin' | 'member'
const actorFor = (userId: string, role: Role, actorType: 'human' | 'agent' = 'human') => ({
  userId,
  actorType,
  actorId: actorType === 'human' ? `files-${userId.slice(0, 6)}@example.test` : `claude-code · files-${userId.slice(0, 6)}@example.test`,
  userDisplayName: `Files ${userId.slice(0, 6)}`,
  role,
  rateKey: `files-${randomUUID()}`,
  sessionId: null,
  agentName: actorType === 'agent' ? 'claude-code' : undefined,
})
const as = (userId: string, role: Role = 'member', actorType: 'human' | 'agent' = 'human') => {
  auth.actor = actorFor(userId, role, actorType)
}

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>

const call = async <P extends Record<string, string>>(
  handler: Handler<P>,
  method: string,
  path: string,
  params: P = {} as P,
  body?: unknown,
) => {
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

const upload = async <P extends Record<string, string>>(
  handler: Handler<P>,
  path: string,
  params: P,
  file: File | null,
) => {
  const form = new FormData()
  if (file) form.append('file', file)
  const response = await handler(
    new Request(`${ORIGIN}/api/v1${path}`, { method: 'POST', headers: { authorization: 'Bearer test' }, body: form }),
    { params: Promise.resolve(params) },
  )
  return { status: response.status, json: (await response.json()) as Record<string, any> }
}

const pulse = async () => (await pool().query('select croft_pulse(null) as p')).rows[0].p as string

let attachmentDir = ''
let todoProjectExisted = false
const subjectIds: string[] = []
const labProjectIds: string[] = []

beforeAll(async () => {
  attachmentDir = await mkdtemp(join(tmpdir(), 'croft-lab-files-'))
  process.env.CROFT_ATTACHMENT_DIR = attachmentDir
  process.env.CROFT_ATTACHMENT_SIGNING_KEY ??= 'integration-signing-key-with-enough-entropy'
  for (const [id, role] of [[adminId, 'admin'], [memberId, 'member'], [otherId, 'member']] as const) {
    await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
      id,
      `files-${role}-${id}@example.test`,
      'not-used',
      role,
    ])
  }
  todoProjectExisted = (await pool().query(`select 1 from projects where key = 'T'`)).rowCount === 1
})

afterAll(async () => {
  if (subjectIds.length) {
    await pool().query('delete from tasks where subject_id = any($1::uuid[])', [subjectIds])
    await pool().query('delete from subjects where id = any($1::uuid[])', [subjectIds])
  }
  if (labProjectIds.length) await pool().query('delete from lab_projects where id = any($1::uuid[])', [labProjectIds])
  if (!todoProjectExisted) {
    await pool().query(`delete from projects where key = 'T' and owner_user_id = any($1::uuid[])`, [[adminId, memberId, otherId]])
  }
  await pool().query('delete from app_users where id = any($1::uuid[])', [[adminId, memberId, otherId]])
  await pool().end()
  await rm(attachmentDir, { recursive: true, force: true })
})

beforeEach(() => as(memberId))

let ref = ''
let otherRef = ''
let projectName = ''

describe('setup', () => {
  it('files two subjects, one in a lab project, each with a todo', async () => {
    as(adminId, 'admin')
    projectName = `Files-${RUN}`
    const project = await call(createLabProjectRoute, 'POST', '/lab-projects', {}, { name: projectName, color: '#4f8c86' })
    expect(project.status).toBe(201)
    labProjectIds.push(project.json.data.id)

    const a = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `Files ${RUN}`, project: projectName })
    const b = await call(createSubjectRoute, 'POST', '/subjects', {}, { title: `Loose ${RUN}` })
    expect([a.status, b.status]).toEqual([201, 201])
    subjectIds.push(a.json.data.id, b.json.data.id)
    ref = a.json.data.ref
    otherRef = b.json.data.ref

    expect((await call(addTodoRoute, 'POST', `/subjects/${ref}/todos`, { ref }, { title: `Bench ${RUN}` })).status).toBe(201)
    expect((await call(addTodoRoute, 'POST', `/subjects/${otherRef}/todos`, { ref: otherRef }, { title: `Loose todo ${RUN}` })).status).toBe(201)
  })
})

describe("people's notes on a subject", () => {
  let noteId = ''
  let agentNoteId = ''

  it('adds a note as its author, newest first, and moves the live pulse', async () => {
    const before = await pulse()
    const added = await call(addHumanNoteRoute, 'POST', `/subjects/${ref}/human-notes`, { ref }, { body: 'Asked Marc: licence is **per seat**.' })
    expect(added.status).toBe(201)
    expect(added.json.data).toMatchObject({ body: 'Asked Marc: licence is **per seat**.', author: { id: memberId, name: expect.any(String) } })
    noteId = added.json.data.id
    expect(await pulse()).not.toBe(before)

    const second = await call(addHumanNoteRoute, 'POST', `/subjects/${ref}/human-notes`, { ref }, { body: 'Second thought.' })
    const list = await call(listHumanNotesRoute, 'GET', `/subjects/${ref}/human-notes`, { ref })
    expect(list.status).toBe(200)
    expect(list.json.data.map((n: { id: string }) => n.id)).toEqual([second.json.data.id, noteId])
    expect((await listSubjectHumanNotes(subjectIds[0]!, { id: memberId, role: 'member' as const })).length).toBe(2)
  })

  it("attributes an agent's note to its human, who can then edit it", async () => {
    as(memberId, 'member', 'agent')
    const added = await call(addHumanNoteRoute, 'POST', `/subjects/${ref}/human-notes`, { ref }, { body: 'Filed from the CLI.' })
    expect(added.status).toBe(201)
    expect(added.json.data.author.id).toBe(memberId)
    agentNoteId = added.json.data.id

    as(memberId)
    const edited = await call(patchHumanNoteRoute, 'PATCH', `/subjects/${ref}/human-notes/${agentNoteId}`, { ref, id: agentNoteId }, { body: 'Filed from the CLI, reworded.' })
    expect(edited.status).toBe(200)
  })

  it('lets only the author edit — administrators included — and moves updated_at', async () => {
    as(adminId, 'admin')
    const refused = await call(patchHumanNoteRoute, 'PATCH', `/subjects/${ref}/human-notes/${noteId}`, { ref, id: noteId }, { body: 'hijack' })
    expect(refused.status).toBe(403)
    expect(refused.json.code).toBe('forbidden')

    as(memberId)
    const before = await pulse()
    const edited = await call(patchHumanNoteRoute, 'PATCH', `/subjects/${ref}/human-notes/${noteId}`, { ref, id: noteId }, { body: 'Licence is per seat, **min 5**.' })
    expect(edited.status).toBe(200)
    expect(edited.json.data.body).toBe('Licence is per seat, **min 5**.')
    expect(edited.json.data.updated_at > edited.json.data.created_at).toBe(true)
    expect(await pulse()).not.toBe(before)
  })

  it('lets the author or an administrator delete; nobody else', async () => {
    as(otherId)
    const refused = await call(deleteHumanNoteRoute, 'DELETE', `/subjects/${ref}/human-notes/${noteId}`, { ref, id: noteId })
    expect(refused.status).toBe(403)

    as(adminId, 'admin')
    const byAdmin = await call(deleteHumanNoteRoute, 'DELETE', `/subjects/${ref}/human-notes/${noteId}`, { ref, id: noteId })
    expect(byAdmin.status).toBe(200)
    expect(byAdmin.json.data).toEqual({ deleted: true, id: noteId })

    as(memberId)
    const byAuthor = await call(deleteHumanNoteRoute, 'DELETE', `/subjects/${ref}/human-notes/${agentNoteId}`, { ref, id: agentNoteId })
    expect(byAuthor.status).toBe(200)
    const gone = await call(deleteHumanNoteRoute, 'DELETE', `/subjects/${ref}/human-notes/${agentNoteId}`, { ref, id: agentNoteId })
    expect(gone.status).toBe(404)
  })

  it('refuses a secret, an empty note, a note on another subject and an unknown subject', async () => {
    const secret = await call(addHumanNoteRoute, 'POST', `/subjects/${ref}/human-notes`, { ref }, { body: `token ghp_${'a1B2c3D4e5'.repeat(4)}` })
    expect(secret.status).toBe(400)
    expect(secret.json.code).toBe('secret_detected')
    expect(JSON.stringify(secret.json)).not.toContain('a1B2c3D4e5a1B2')

    const empty = await call(addHumanNoteRoute, 'POST', `/subjects/${ref}/human-notes`, { ref }, { body: '   ' })
    expect(empty.status).toBe(400)

    const [remaining] = (await listSubjectHumanNotes(subjectIds[0]!, { id: memberId, role: 'member' as const }))
    const crossed = await call(patchHumanNoteRoute, 'PATCH', `/subjects/${otherRef}/human-notes/${remaining!.id}`, { ref: otherRef, id: remaining!.id }, { body: 'x' })
    expect(crossed.status).toBe(404)

    const missing = await call(listHumanNotesRoute, 'GET', '/subjects/S-999999/human-notes', { ref: 'S-999999' })
    expect(missing.status).toBe(404)
    const badId = await call(deleteHumanNoteRoute, 'DELETE', `/subjects/${ref}/human-notes/not-a-uuid`, { ref, id: 'not-a-uuid' })
    expect(badId.status).toBe(404)
  })
})

describe('files on a subject', () => {
  let imageId = ''
  let htmlId = ''

  it('uploads an image and answers the Attachment, with a stable content_url; the pulse moves', async () => {
    const before = await pulse()
    const res = await upload(uploadSubjectFileRoute, `/subjects/${ref}/attachments`, { ref }, new File([Buffer.from('png-bytes')], 'shot 1.png', { type: 'image/png' }))
    expect(res.status).toBe(201)
    const a = res.json.data
    expect(a).toMatchObject({ filename: 'shot 1.png', mime_type: 'image/png', size_bytes: 9, kind: 'image', uploaded_by: expect.stringContaining('files-') })
    expect(a.content_url).toBe(`/api/v1/attachments/${a.id}/content`)
    expect(a.preview_url).toMatch(/^\/api\/files\?/)
    expect(a.download_url).toMatch(/download=shot/)
    imageId = a.id
    expect(await pulse()).not.toBe(before)
  })

  it('accepts HTML, typed by extension when the browser sends none, and serves it only sandboxed', async () => {
    const res = await upload(uploadSubjectFileRoute, `/subjects/${ref}/attachments`, { ref }, new File(['<script>alert(1)</script><h1>bench</h1>'], 'report.htm', { type: '' }))
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ mime_type: 'text/html', kind: 'html' })
    htmlId = res.json.data.id

    const served = await filesRoute(new Request(`${ORIGIN}${res.json.data.preview_url}`))
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('text/html')
    expect(served.headers.get('content-security-policy')).toBe('sandbox')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('refuses a blocked extension, a type off the allowlist, an empty file and a missing field', async () => {
    const exe = await upload(uploadSubjectFileRoute, `/subjects/${ref}/attachments`, { ref }, new File(['MZ'], 'setup.exe', { type: 'application/octet-stream' }))
    expect(exe.status).toBe(400)
    expect(exe.json.code).toBe('validation_failed')
    const xhtml = await upload(uploadSubjectFileRoute, `/subjects/${ref}/attachments`, { ref }, new File(['<x/>'], 'a.xhtml', { type: 'application/xhtml+xml' }))
    expect(xhtml.status).toBe(400)
    expect(xhtml.json.validTypes).toContain('text/html')
    const empty = await upload(uploadSubjectFileRoute, `/subjects/${ref}/attachments`, { ref }, new File([], 'a.png', { type: 'image/png' }))
    expect(empty.status).toBe(400)
    const none = await upload(uploadSubjectFileRoute, `/subjects/${ref}/attachments`, { ref }, null)
    expect(none.status).toBe(400)
    const unknown = await upload(uploadSubjectFileRoute, '/subjects/S-999999/attachments', { ref: 'S-999999' }, new File(['x'], 'a.txt', { type: 'text/plain' }))
    expect(unknown.status).toBe(404)
  })

  it("lists the subject's files oldest first", async () => {
    const list = await call(listSubjectFilesRoute, 'GET', `/subjects/${ref}/attachments`, { ref })
    expect(list.json.data.map((a: { id: string }) => a.id)).toEqual([imageId, htmlId])
    expect((await listSubjectAttachments(subjectIds[0]!, { id: memberId, role: 'member' as const })).map((a) => a.kind)).toEqual(['image', 'html'])
    const refreshed = await call(attachmentRoute, 'GET', `/attachments/${imageId}`, { id: imageId })
    expect(refreshed.status).toBe(200)
    expect(refreshed.json.data).toMatchObject({ id: imageId, kind: 'image', subject_id: subjectIds[0] })
  })

  it('redirects the stable content_url to a fresh signed preview, relative, uncached', async () => {
    const res = await contentRoute(new Request(`${ORIGIN}/api/v1/attachments/${imageId}/content`), { params: Promise.resolve({ id: imageId }) })
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(location).toMatch(/^\/api\/files\?/)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const served = await filesRoute(new Request(`${ORIGIN}${location}`))
    expect(served.status).toBe(200)
    expect(Buffer.from(await served.arrayBuffer()).toString()).toBe('png-bytes')

    const missing = await contentRoute(new Request(`${ORIGIN}/api/v1/attachments/${randomUUID()}/content`), { params: Promise.resolve({ id: randomUUID() }) })
    expect(missing.status).toBe(404)
    auth.actor = null
    const anonymous = await contentRoute(new Request(`${ORIGIN}/api/v1/attachments/${imageId}/content`), { params: Promise.resolve({ id: imageId }) })
    expect(anonymous.status).toBe(401)
  })

  it('deletes a file through its own subject only, bytes and row', async () => {
    const wrong = await call(deleteSubjectFileRoute, 'DELETE', `/subjects/${otherRef}/attachments/${htmlId}`, { ref: otherRef, id: htmlId })
    expect(wrong.status).toBe(404)
    const before = await pulse()
    const deleted = await call(deleteSubjectFileRoute, 'DELETE', `/subjects/${ref}/attachments/${htmlId}`, { ref, id: htmlId })
    expect(deleted.status).toBe(200)
    expect(deleted.json.data).toEqual({ deleted: true, id: htmlId })
    expect(await pulse()).not.toBe(before)
    expect((await listSubjectAttachments(subjectIds[0]!, { id: memberId, role: 'member' as const })).map((a) => a.id)).toEqual([imageId])
  })
})

describe("a todo's files", () => {
  it('accepts HTML on a todo too, and every response carries kind and content_url', async () => {
    const todoRef = (await pool().query(
      `select 'T-' || number as ref, id from tasks where subject_id = $1`, [subjectIds[0]],
    )).rows[0] as { ref: string; id: string }
    const res = await upload(uploadTaskFileRoute, `/tasks/${todoRef.ref}/attachments`, { ref: todoRef.ref }, new File(['<p>r</p>'], 'r.html', { type: 'text/html' }))
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ original_name: 'r.html', mime_type: 'text/html', kind: 'html', filename: 'r.html' })
    expect(res.json.data.previewUrl).toMatch(/^\/api\/files\?/)
    expect(res.json.data.content_url).toBe(`/api/v1/attachments/${res.json.data.id}/content`)
    expect(res.json.data).not.toHaveProperty('storage_path')

    const list = await call(listTaskFilesRoute, 'GET', `/tasks/${todoRef.ref}/attachments`, { ref: todoRef.ref })
    expect(list.json.data[0]).toMatchObject({ id: res.json.data.id, kind: 'html', original_name: 'r.html' })
    expect(list.json.data[0]).not.toHaveProperty('storage_path')
    expect((await listTaskAttachments(todoRef.id, { id: memberId, role: 'member' as const }))[0]).toMatchObject({ kind: 'html', filename: 'r.html' })

    const content = await contentRoute(new Request(`${ORIGIN}/api/v1/attachments/${res.json.data.id}/content`), { params: Promise.resolve({ id: res.json.data.id }) })
    expect(content.status).toBe(302)
    const served = await filesRoute(new Request(`${ORIGIN}${content.headers.get('location')}`))
    expect(served.headers.get('content-security-policy')).toBe('sandbox')
  })
})

describe('todo lists carry their subject', () => {
  it('GET /projects/T/tasks adds subject {ref, number, title, project} and filters by subject and project', async () => {
    const all = await call(listProjectTasksRoute, 'GET', '/projects/T/tasks?limit=200', { id: 'T' })
    expect(all.status).toBe(200)
    const mine = all.json.data.tasks.find((t: { title: string }) => t.title === `Bench ${RUN}`)
    expect(mine.subject).toEqual({ ref, number: Number(ref.slice(2)), title: `Files ${RUN}`, project: { name: projectName, color: '#4f8c86' }, visibility: 'lab' })
    expect(mine.subject_ref).toBe(ref)

    const bySubject = await call(listProjectTasksRoute, 'GET', `/projects/T/tasks?subject=${ref}`, { id: 'T' })
    expect(bySubject.json.data.tasks.map((t: { title: string }) => t.title)).toEqual([`Bench ${RUN}`])

    const byProject = await call(listProjectTasksRoute, 'GET', `/projects/T/tasks?project=${projectName.toLowerCase()}&limit=200`, { id: 'T' })
    expect(byProject.json.data.tasks.map((t: { title: string }) => t.title)).toEqual([`Bench ${RUN}`])

    const none = await call(listProjectTasksRoute, 'GET', '/projects/T/tasks?project=none&limit=200', { id: 'T' })
    const noneTitles = none.json.data.tasks.map((t: { title: string }) => t.title)
    expect(noneTitles).toContain(`Loose todo ${RUN}`)
    expect(noneTitles).not.toContain(`Bench ${RUN}`)
    const loose = none.json.data.tasks.find((t: { title: string }) => t.title === `Loose todo ${RUN}`)
    expect(loose.subject).toMatchObject({ ref: otherRef, project: null })

    const unknownProject = await call(listProjectTasksRoute, 'GET', '/projects/T/tasks?project=no-such-project-anywhere', { id: 'T' })
    expect(unknownProject.status).toBe(400)
    expect(unknownProject.json).toMatchObject({ code: 'validation_failed', valid: expect.arrayContaining([projectName]) })
    const unknownSubject = await call(listProjectTasksRoute, 'GET', '/projects/T/tasks?subject=S-999999', { id: 'T' })
    expect(unknownSubject.status).toBe(404)
  })

  it('listLabTodos gives the LabTodo shape and the same filters', async () => {
    const byProject = await listLabTodos({ project: projectName }, { id: memberId, role: 'member' as const })
    expect(byProject).toHaveLength(1)
    expect(byProject[0]).toMatchObject({
      ref: expect.stringMatching(/^T-\d+$/),
      title: `Bench ${RUN}`,
      status: 'todo',
      priority: 'medium',
      claimed_by: null,
      handoff: null,
      assignee: { id: adminId, name: expect.any(String) },
      subject: { ref, title: `Files ${RUN}`, project: { name: projectName, color: '#4f8c86' } },
    })
    expect((await listLabTodos({ subject: otherRef }, { id: memberId, role: 'member' as const })).map((t) => t.title)).toEqual([`Loose todo ${RUN}`])
    expect((await listLabTodos({ project: 'none' }, { id: memberId, role: 'member' as const })).map((t) => t.title)).toContain(`Loose todo ${RUN}`)
    expect(await listLabTodos({ project: 'no-such-project-anywhere' }, { id: memberId, role: 'member' as const })).toEqual([])

    await pool().query(`update tasks set status = 'done' where subject_id = $1`, [subjectIds[1]])
    expect(await listLabTodos({ subject: otherRef }, { id: memberId, role: 'member' as const })).toEqual([])
    expect((await listLabTodos({ subject: otherRef, includeClosed: true }, { id: memberId, role: 'member' as const })).map((t) => t.status)).toEqual(['done'])
  })

  it('the board carries it too', async () => {
    const board = await listBoardTasks('', { includeClosed: true }, { id: memberId, role: 'member' as const })
    const card = board.tasks.find((t) => t.title === `Bench ${RUN}`)!
    expect(card.subject).toMatchObject({ ref, project: { name: projectName } })
    expect(card).not.toHaveProperty('cairn_ref')
    expect(card).toHaveProperty('handoff', null)

  })
})

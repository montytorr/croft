import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Security review F1: when a project moves between Croft instances, the copy
 * left behind is archived. Before this, nothing stopped a CLI still routed to
 * that instance by a stale cache from closing, noting or claiming a task in
 * it — reads were refused nowhere, but neither were writes. This is that gap,
 * against a real database and the actual route handlers, because the guard
 * (`refuseArchived`) reads an embedded `project.status` the adapter has to
 * actually return for the check to mean anything.
 */

const auth = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return {
    ...actual,
    authenticate: async () => auth.actor,
  }
})

import { pool } from '@/lib/db/client'
import { GET as showTaskRoute, PATCH as taskPatch, DELETE as taskDelete } from '@/app/api/v1/tasks/[ref]/route'
import { POST as claimTask } from '@/app/api/v1/tasks/[ref]/claim/route'
import { GET as listNotes, POST as createNote } from '@/app/api/v1/tasks/[ref]/notes/route'
import { PATCH as projectPatch } from '@/app/api/v1/projects/[id]/route'
import { POST as createTask, GET as listTasks } from '@/app/api/v1/projects/[id]/tasks/route'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ORIGIN = 'https://croft.example.test'
const ownerId = randomUUID()
const projectId = randomUUID()
const KEY = `AR${String(Date.now()).slice(-6)}`
const AGENT = 'claude-code · archived-writes@example.test'

const asAgent = () => {
  auth.actor = {
    userId: ownerId,
    actorType: 'agent',
    actorId: AGENT,
    userDisplayName: 'Archived Writes',
    role: 'admin',
    rateKey: `archived-writes-${randomUUID()}`,
    sessionId: null,
    agentName: 'claude-code',
  }
}

// Every mutating call below carries a bearer-shaped header: `authenticate`
// is mocked, so it is never checked for validity, but `isTrustedMutationOrigin`
// (a real, unmocked gate in the route wrapper) requires one on any unsafe
// method, real key or not.
const jsonHeaders = { 'content-type': 'application/json', authorization: 'Bearer test' }

const patchTask = (ref: string, body: Record<string, unknown>) =>
  taskPatch(new Request(`${ORIGIN}/api/v1/tasks/${ref}`, {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body),
  }), { params: Promise.resolve({ ref }) })

const deleteTask = (ref: string) =>
  taskDelete(new Request(`${ORIGIN}/api/v1/tasks/${ref}`, {
    method: 'DELETE', headers: { authorization: 'Bearer test' },
  }), { params: Promise.resolve({ ref }) })

const claim = (ref: string) =>
  claimTask(new Request(`${ORIGIN}/api/v1/tasks/${ref}/claim`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({}),
  }), { params: Promise.resolve({ ref }) })

const note = (ref: string) =>
  createNote(new Request(`${ORIGIN}/api/v1/tasks/${ref}/notes`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ kind: 'note', note: 'hi' }),
  }), { params: Promise.resolve({ ref }) })

const notesOf = (ref: string) =>
  listNotes(new Request(`${ORIGIN}/api/v1/tasks/${ref}/notes`), { params: Promise.resolve({ ref }) })

const showTask = (ref: string) =>
  showTaskRoute(new Request(`${ORIGIN}/api/v1/tasks/${ref}`), { params: Promise.resolve({ ref }) })

const setProjectStatus = (status: string) =>
  projectPatch(new Request(`${ORIGIN}/api/v1/projects/${projectId}`, {
    method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status }),
  }), { params: Promise.resolve({ id: projectId }) })

const addTaskToProject = () =>
  createTask(new Request(`${ORIGIN}/api/v1/projects/${projectId}/tasks`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ title: 'Filed while archived' }),
  }), { params: Promise.resolve({ id: projectId }) })

const listProjectTasks = () =>
  listTasks(new Request(`${ORIGIN}/api/v1/projects/${projectId}/tasks`), {
    params: Promise.resolve({ id: projectId }),
  })

let ref = ''

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
    ownerId,
    `archived-writes-${ownerId}@example.test`,
    'not-used',
    'admin',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title, task_counter) values ($1,$2,$3,'Archived writes',1)`,
    [projectId, ownerId, KEY],
  )
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status)
     values ($1,$2,1,'Lives in a project that gets archived','agent',$3,'todo')`,
    [randomUUID(), projectId, AGENT],
  )
  ref = `${KEY}-1`
})

afterAll(async () => {
  await pool().query('delete from tasks where project_id = $1', [projectId])
  await pool().query('delete from projects where id = $1', [projectId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

beforeEach(() => {
  asAgent()
})

describe('writes to a task in an archived project', () => {
  it('archives the project', async () => {
    const response = await setProjectStatus('archived')
    expect(response.status).toBe(200)
    expect((await response.json()).data.status).toBe('archived')
  })

  it('still allows reading the task', async () => {
    const response = await showTask(ref)
    expect(response.status).toBe(200)
    expect((await response.json()).data.title).toBe('Lives in a project that gets archived')
  })

  it('still allows reading its notes and the project task list', async () => {
    expect((await notesOf(ref)).status).toBe(200)
    const listed = await listProjectTasks()
    expect(listed.status).toBe(200)
    expect((await listed.json()).data.count).toBeGreaterThan(0)
  })

  it('refuses PATCH with 409 conflict, naming the project and what to do', async () => {
    const response = await patchTask(ref, { priority: 'high' })
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.success).toBe(false)
    expect(body.code).toBe('conflict')
    expect(body.error).toContain(KEY)
    expect(body.error).toContain('archived')
    expect(body.error).toContain('--instance')
    expect(body.error).toContain('restore')
  })

  it('refuses adding a note with 409 conflict', async () => {
    const response = await note(ref)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('conflict')
  })

  it('refuses claiming with 409 conflict', async () => {
    const response = await claim(ref)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('conflict')
  })

  it('refuses deleting the task with 409 conflict', async () => {
    const response = await deleteTask(ref)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('conflict')
  })

  it('refuses filing a new task into the archived project with 409 conflict', async () => {
    const response = await addTaskToProject()
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe('conflict')
    expect(body.error).toContain(KEY)
  })

  it('restores the project, after which the same writes succeed', async () => {
    const restored = await setProjectStatus('active')
    expect(restored.status).toBe(200)
    expect((await restored.json()).data.status).toBe('active')

    const patched = await patchTask(ref, { priority: 'high' })
    expect(patched.status).toBe(200)
    expect((await patched.json()).data.priority).toBe('high')

    const claimed = await claim(ref)
    expect(claimed.status).toBe(200)

    const created = await addTaskToProject()
    expect(created.status).toBe(201)
  })
})

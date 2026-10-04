import { admin, pool } from '@/lib/db/client'
import type { Actor } from './auth'
import { diffTaskEvents, recordActivity } from './activity'
import { subjectRef, type SubjectVisibility } from '@/lib/lab/types'
import { fail } from './response'
import { isTaskVisible } from './visibility'

/**
 * Columns returned by `show`. Kept explicit so responses stay predictable.
 *
 * The embed carries `status` alongside `key`/`title` so every route that
 * resolves a task through this projection already has what `refuseArchived`
 * needs, with no second query.
 */
export const TASK_FIELDS =
  'id, project_id, number, title, description, type, status, priority, labels, due_date, position, ' +
  'actor_type, actor_id, assignee_user_id, claimed_by, claimed_session, claimed_at, heartbeat_at, attempt, ownership_version, ' +
  'checkpoint_summary, checkpoint_payload, checkpoint_at, checkpoint_version, blocked_reason, blocked_at, ' +
  'resolution, resolution_kind, resolved_at, resolved_by, duplicate_of, parent_id, ' +
  'memory_session_id, observation_ids, created_at, updated_at, ' +
  // A todo's subject, and the task it was handed off to in another tracker.
  'subject_id, handoff_tracker, handoff_ref, handoff_url, handoff_status, handoff_synced_at, ' +
  'project:projects!project_id!inner(id, key, title, status)'

/** Terse columns for list/search output. See the CLI's output discipline. */
export const TASK_LIST_FIELDS =
  'id, number, title, type, status, priority, labels, assignee_user_id, claimed_by, claimed_session, claimed_at, heartbeat_at, attempt, ownership_version, checkpoint_version, ' +
  // project_id as well as the embed: an activity row records the project by id,
  // and it is the only scope that survives the task being deleted.
  'resolution, updated_at, project_id, ' +
  // The hand-off decides whether a status change is allowed, so every route that finds a task sees it.
  'handoff_tracker, handoff_ref, handoff_url, handoff_status, handoff_synced_at, ' +
  'project:projects!project_id!inner(key, status)'

/**
 * A project's task list also says, per row, which subject a todo is part of
 * and the tracker task it was handed off to: `croft sync` pairs todos off this
 * list. `subject` is folded into `subject_ref` by `withSubjectRefs`.
 */
export const TASK_LIST_LAB_FIELDS =
  `${TASK_LIST_FIELDS}, subject:subjects!subject_id(number)`

/** `subject: {number}` (or null) becomes `subject_ref: 'S-12'` (or null). */
export const withSubjectRefs = <T extends Record<string, unknown>>(rows: T[]) =>
  rows.map(({ subject, ...row }) => {
    const embedded = (Array.isArray(subject) ? subject[0] : subject) as { number?: number } | null | undefined
    return { ...row, subject_ref: typeof embedded?.number === 'number' ? subjectRef(embedded.number) : null }
  })

export type TaskRef = { key: string; number: number } | { id: string }

/** A bare `subject_id` column in a select list (not the `subjects!subject_id` embed hint). */
const SUBJECT_ID_COLUMN = /(^|,)\s*subject_id\s*(,|$)/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Accepts either `CAI-42` or a raw UUID, so both prose refs and ids work. */
export const parseRef = (raw: string): TaskRef | null => {
  const value = decodeURIComponent(raw).trim()
  if (UUID.test(value)) return { id: value }

  const match = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/.exec(value)
  if (!match?.[1] || !match[2]) return null
  return { key: match[1].toUpperCase(), number: Number(match[2]) }
}

export type TaskRow = Record<string, unknown> & { id: string }

/** "HOL-113", from a row with either embedding of its project. */
export const refOfRow = (row: Record<string, unknown>) => {
  const embedded = (row.project ?? row.projects) as { key?: string } | { key?: string }[] | undefined
  const key = (Array.isArray(embedded) ? embedded[0] : embedded)?.key
  return key ? `${key}-${row.number as number}` : null
}

/**
 * Resolves a ref to a task in the shared workspace.
 *
 * Hidden is missing: a todo of a subject the caller cannot see answers exactly
 * as a ref that names nothing.
 */
export const findTask = async (
  actor: Pick<Actor, 'userId'>,
  raw: string,
  fields = TASK_FIELDS,
): Promise<TaskRow | null> => {
  const ref = parseRef(raw)
  if (!ref) return null

  // Key-based refs need the embedded project relation even when callers request
  // a narrow projection. `status` rides along so `refuseArchived` works for
  // callers that asked for a narrow field set too.
  const withProject = fields.includes('projects!project_id!inner')
    ? fields
    : `${fields}, projects!project_id!inner(key, status)`
  // The subject decides who may see the task (v0.4), so it is read whatever
  // projection the caller asked for.
  const select = SUBJECT_ID_COLUMN.test(withProject) ? withProject : `${withProject}, subject_id`

  const query = admin().from('tasks').select(select)

  const { data, error } =
    'id' in ref
      ? await query.eq('id', ref.id).maybeSingle()
      : await query.eq('number', ref.number).eq('projects.key', ref.key).maybeSingle()

  // A PostgREST error is NOT "no such task" — maybeSingle() reports zero rows
  // as data: null with no error.
  if (error) throw new Error(`task lookup failed: ${error.message}`)
  if (!data) return null
  const task = data as unknown as TaskRow
  return (await isTaskVisible(task.subject_id, actor.userId)) ? task : null
}

/** A task row's embedded project, whichever alias or shape fetched it. */
const embeddedProject = (row: Record<string, unknown>) => {
  const embedded = (row.project ?? row.projects) as
    | { key?: string; status?: string }
    | { key?: string; status?: string }[]
    | undefined
  return Array.isArray(embedded) ? embedded[0] : embedded
}

/**
 * Refuses a write to a task whose HOME project is archived. Nothing in the API
 * archives a project any more; this guards a row archived by hand.
 *
 * Call this with the row `findTask` already returned: it reads the embedded
 * project rather than querying again. Reads stay allowed, only writes are
 * refused.
 */
export const refuseArchived = (task: TaskRow) => {
  const project = embeddedProject(task)
  if (!project || project.status !== 'archived') return null

  const key = project.key ?? 'its project'
  const number = task.number as number | undefined
  const ref = project.key && number !== undefined ? `${project.key}-${number}` : 'This task'

  return fail(
    'conflict',
    `${ref} lives in ${key}, which is archived. Restore the project before writing to it.`,
    { project: project.key ?? null, projectStatus: 'archived' },
  )
}

/**
 * Resolves a would-be parent and refuses anything that would close a loop.
 *
 * The self-check lives in the database; a -> b -> a does not, because it needs
 * a walk. `task_is_descendant` does that walk in one round trip so the API and
 * the database cannot disagree about what a cycle is.
 */
export const resolveParent = async (
  actor: Actor,
  childId: string,
  raw: string,
): Promise<{ id: string } | { error: string }> => {
  const parent = await findTask(actor, raw, 'id, number, title')
  if (!parent) return { error: `No task ${raw}.` }
  if (parent.id === childId) return { error: 'A task cannot be its own parent.' }

  const { data, error } = await admin().rpc('task_is_descendant', {
    p_candidate: parent.id,
    p_ancestor: childId,
  })
  if (error) return { error: error.message }
  if (data === true) {
    return { error: `${raw} is already nested beneath this task — that would be a loop.` }
  }
  return { id: parent.id }
}

/**
 * A claim let go. Finishing a task releases it — without this the claim
 * outlives the work, and a board where done tasks still show a holder makes
 * the one field an agent checks before picking something up untrustworthy.
 * The session goes with the claim: left behind, it answers "which session
 * holds this" with one that finished the work and moved on.
 */
export const RELEASED_CLAIM = {
  claimed_by: null,
  claimed_session: null,
  claimed_at: null,
  heartbeat_at: null,
} as const

export type CloseInput = {
  status: 'done' | 'cancelled'
  resolution: string
  resolutionKind: string
}

type ClosableTask = {
  id: string
  status: string
  resolution?: string | null
  resolution_kind?: string | null
  claimed_by?: string | null
}

/**
 * Closes a task the way `PATCH /tasks/{ref}` does — a status, the answer and
 * who gave it, the claim released — and records the same events. For a close
 * that is a consequence rather than a request: a todo whose hand-off ended.
 */
export const closeTask = async (actor: Actor, task: ClosableTask, close: CloseInput) => {
  const patch: Record<string, unknown> = {
    status: close.status,
    resolution: close.resolution,
    resolution_kind: close.resolutionKind,
    resolved_at: new Date().toISOString(),
    resolved_by: actor.actorId,
    ...(task.claimed_by ? RELEASED_CLAIM : {}),
  }
  const { error } = await admin().from('tasks').update(patch).eq('id', task.id)
  if (error) throw new Error(`closing ${task.id} failed: ${error.message}`)
  await recordActivity(diffTaskEvents(actor, task.id, task, patch), actor.userId, actor.host)
}

export type TaskSubject = {
  ref: string
  number: number
  title: string
  /**
   * The subject's lab project, and where its todos go: `croft handoff T-n`
   * with no `--to` uses `handoff_tracker` and `handoff_target`.
   */
  project: {
    name: string
    handoff_tracker: string | null
    handoff_target: string | null
  } | null
  /**
   * Who can see the subject, and so the todo (v0.4). `croft handoff` refuses a
   * todo whose subject is not `lab` unless forced: a tracker has no notion of it.
   */
  visibility: SubjectVisibility
}

/**
 * The subject a todo belongs to — "part of S-12" — or null for an ordinary
 * task, or for a subject the viewer cannot see.
 */
export const subjectOfTask = async (subjectId: unknown, viewerId: string): Promise<TaskSubject | null> => {
  if (typeof subjectId !== 'string' || !subjectId) return null
  const result = await pool().query(
    `select s.number, s.title, s.visibility, lp.name as project_name, lp.handoff_tracker, lp.handoff_target
       from subjects s
       left join lab_projects lp on lp.id = s.project_id
      where s.id = $1 and croft_subject_visible(s.id, $2::uuid)`,
    [subjectId, viewerId],
  )
  const row = result.rows[0] as
    | { number: number; title: string; visibility: SubjectVisibility; project_name: string | null; handoff_tracker: string | null; handoff_target: string | null }
    | undefined
  if (!row) return null
  return {
    ref: subjectRef(row.number),
    number: row.number,
    title: row.title,
    project:
      row.project_name === null
        ? null
        : {
            name: row.project_name,
            handoff_tracker: row.handoff_tracker,
            handoff_target: row.handoff_target,
          },
    visibility: row.visibility,
  }
}

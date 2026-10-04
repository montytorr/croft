import { admin } from '@/lib/db/client'
import { sessionUser } from '@/lib/auth/session'
import { withAssignee, type Person } from '@/lib/api/people'
import type { TaskPriority, TaskStatus, TaskType } from '@/schemas/task'
import { subjectRef, type Attachment as LabAttachment, type SubjectVisibility } from '@/lib/lab/types'
import { toAttachment } from '@/lib/attachments'
import { isTaskIdVisible, isTaskVisible, restrictTo, visibleTasksOr, withoutHiddenLinks, type Viewer } from '@/lib/api/visibility'

export type Task = {
  id: string
  number: number
  title: string
  description: string | null
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  labels: string[]
  due_date: string | null
  position: number
  actor_type: 'human' | 'agent'
  actor_id: string
  assignee_user_id: string
  /** Named live off `assignee_user_id`, not stored — see `withAssignee`. */
  assignee: Person | null
  claimed_by: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  attempt: number
  checkpoint_summary: string | null
  checkpoint_at: string | null
  blocked_reason: string | null
  resolution: string | null
  resolution_kind: string | null
  resolved_at: string | null
  resolved_by: string | null
  external_ref: string | null
  external_url: string | null
  has_resolution: boolean
  duplicate_of: string | null
  parent_id: string | null
  created_at: string
  updated_at: string
}

export type Project = {
  id: string
  key: string
  title: string
  description: string | null
  status: string
  task_counter: number
}

/** Workspace data is shared by every active user. */
export const currentUser = async () => {
  return sessionUser()
}

/** The subject a todo is part of, for "part of S-12". Null on an ordinary task. */
export type TaskSubject = { ref: string; number: number; title: string; visibility: SubjectVisibility }

/** A task by ref, or null when there is none or `viewer` may not see it — one answer for both. */
export const getTask = async (
  _userId: string,
  key: string,
  number: number,
  viewer: Viewer,
): Promise<(Task & { project: Project; subject: TaskSubject | null }) | null> => {
  const { data } = await admin()
    .from('tasks')
    .select(
      '*, project:projects!project_id!inner(id, key, title, description, status, task_counter), ' +
        'subject:subjects!subject_id(number, title, visibility)',
    )
    .eq('projects.key', key.toUpperCase())
    .eq('number', number)
    .maybeSingle()
  if (!data) return null
  const row = data as unknown as Task & {
    project: Project
    subject_id: string | null
    subject: { number: number; title: string; visibility: SubjectVisibility } | null
  }
  if (!(await isTaskVisible(row.subject_id, viewer.id))) return null
  const subject = row.subject
    ? {
        ref: subjectRef(row.subject.number),
        number: row.subject.number,
        title: row.subject.title,
        visibility: row.subject.visibility,
      }
    : null
  // The row goes to a client component whole: no ids of hidden tasks in it.
  return await withAssignee(await withoutHiddenLinks({ ...row, subject }, viewer.id))
}

/**
 * The ref and title of whatever a task duplicates. Its own query rather than a
 * join on getTask: it is null for almost every task, and `select *` already
 * pulls more than the detail page needs.
 */
export const getDuplicateOf = async (
  taskId: string,
  viewer: Viewer,
): Promise<{ ref: string; title: string; status: string } | null> => {
  const { data } = await admin()
    .from('tasks')
    .select('number, title, status, subject_id, project:projects!project_id!inner(key)')
    .eq('id', taskId)
    .maybeSingle()
  if (!data) return null
  const row = data as unknown as {
    number: number
    title: string
    status: string
    subject_id: string | null
    project: { key: string } | { key: string }[]
  }
  if (!(await isTaskVisible(row.subject_id, viewer.id))) return null
  const project = Array.isArray(row.project) ? row.project[0] : row.project
  return { ref: `${project?.key}-${row.number}`, title: row.title, status: row.status }
}

export type ChildTask = {
  id: string
  number: number
  title: string
  status: TaskStatus
  type: TaskType
  priority: TaskPriority
  project_key: string
}

/** Direct children only. A tree view of a two-level split is noise. */
export const listChildren = async (taskId: string, viewer: Viewer): Promise<ChildTask[]> => {
  const { data } = await restrictTo(
    admin().from('tasks').select('id, number, title, status, type, priority, project:projects!project_id!inner(key)'),
    await visibleTasksOr(viewer.id),
  )
    .eq('parent_id', taskId)
    .order('created_at')
  return ((data ?? []) as unknown as (Omit<ChildTask, 'project_key'> & {
    project: { key: string } | { key: string }[]
  })[]).map((row) => {
    const project = Array.isArray(row.project) ? row.project[0] : row.project
    return { ...row, project_key: project?.key ?? '' }
  })
}

/** The parent's ref and title, for the breadcrumb on a child. */
export const getParent = async (
  taskId: string,
  viewer: Viewer,
): Promise<{ ref: string; title: string; status: TaskStatus } | null> => {
  const { data } = await admin()
    .from('tasks')
    .select('number, title, status, subject_id, project:projects!project_id!inner(key)')
    .eq('id', taskId)
    .maybeSingle()
  if (!data) return null
  const row = data as unknown as {
    number: number
    title: string
    status: TaskStatus
    subject_id: string | null
    project: { key: string } | { key: string }[]
  }
  if (!(await isTaskVisible(row.subject_id, viewer.id))) return null
  const project = Array.isArray(row.project) ? row.project[0] : row.project
  return { ref: `${project?.key}-${row.number}`, title: row.title, status: row.status }
}

export type ActivityEntry = {
  id: string
  event: string
  data: Record<string, unknown> | null
  actor_type: string
  actor_id: string
  created_at: string
}

/** The audit trail for one task, newest first. */
export const listActivity = async (taskId: string, viewer: Viewer): Promise<ActivityEntry[]> => {
  if (!(await isTaskIdVisible(taskId, viewer.id))) return []
  const { data } = await admin()
    .from('task_activity_events')
    .select('id, event, data, actor_type, actor_id, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(200)
  return (data ?? []) as ActivityEntry[]
}

export type Note = {
  id: string
  kind: string
  note: string
  facts: string[] | null
  actor_type: string
  actor_id: string
  created_at: string
}

export const listNotes = async (taskId: string, viewer: Viewer): Promise<Note[]> => {
  if (!(await isTaskIdVisible(taskId, viewer.id))) return []
  const { data } = await admin()
    .from('task_notes')
    .select('id, kind, note, facts, actor_type, actor_id, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
  return (data ?? []) as Note[]
}

export type Comment = {
  id: string
  content: string
  comment_type: string
  actor_type: string
  actor_id: string
  created_at: string
}

export const listComments = async (taskId: string, viewer: Viewer): Promise<Comment[]> => {
  if (!(await isTaskIdVisible(taskId, viewer.id))) return []
  const { data } = await admin()
    .from('task_comments')
    .select('id, content, comment_type, actor_type, actor_id, created_at')
    .eq('task_id', taskId)
    .order('created_at')
  return (data ?? []) as Comment[]
}

/**
 * A task's files in the lab's `Attachment` shape — `kind`, fresh signed
 * `preview_url`/`download_url` and the stable `content_url` — for a page that
 * previews them inline. The links expire within the hour; a page re-renders
 * well before that, and `content_url` never expires.
 */
export const listTaskAttachments = async (taskId: string, viewer: Viewer): Promise<LabAttachment[]> => {
  if (!(await isTaskIdVisible(taskId, viewer.id))) return []
  const { data } = await admin()
    .from('task_attachments')
    .select('id, original_name, mime_type, size_bytes, actor_id, storage_path, created_at')
    .eq('task_id', taskId)
    .order('created_at')
  type Row = { id: string; original_name: string; mime_type: string; size_bytes: number; actor_id: string; storage_path: string; created_at: string }
  return Promise.all(
    ((data ?? []) as Row[]).map((row) =>
      toAttachment({ ...row, filename: row.original_name, uploaded_by: row.actor_id }),
    ),
  )
}

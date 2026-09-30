import { admin } from '@/lib/db/client'
import { byTitle } from '@/lib/utils'
import { sessionUser } from '@/lib/auth/session'
import { withAssignee, withAssignees, type Person } from '@/lib/api/people'
import type { TaskPriority, TaskStatus, TaskType } from '@/schemas/task'
import { subjectRef, type Attachment as LabAttachment, type SubjectVisibility } from '@/lib/lab/types'
import { withTaskSubjects, type LabTodoSubject } from '@/lib/api/lab-todos'
import { toAttachment } from '@/lib/attachments'
import { isTaskIdVisible, isTaskVisible, restrictTo, visibleTasksOr, type Viewer } from '@/lib/api/visibility'

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

/**
 * Archived projects are excluded by default. Archiving exists so a finished
 * project can leave a 33-item sidebar without being destroyed, which only
 * works if the default view actually drops it.
 */
export const listProjects = async (
  _userId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
  // Projects are not scoped (their `task_counter` is a high-water mark; gaps
  // in T-n numbering are accepted, see SECURITY.md). Taken for uniformity.
  _viewer?: Viewer,
): Promise<Project[]> => {
  const query = admin()
    .from('projects')
    .select('id, key, title, description, status, task_counter')
  /**
   * Alphabetical by title, which is what the sidebar shows.
   *
   * The order was `position` then `created_at`, and nothing has ever written a
   * project's position — so every project sat at 0 and the list was really in
   * creation order. That is findable only by someone who remembers when they
   * made each one, and it drifts further from useful with every new project.
   * Sorted by title rather than key because the title is the text a reader
   * scans; the key is the small mark at the end of the row.
   */
  const { data } = await (includeArchived ? query : query.eq('status', 'active')).order('title')
  return ((data ?? []) as Project[]).sort(byTitle)
}

export const getProject = async (_userId: string, key: string): Promise<Project | null> => {
  const { data } = await admin()
    .from('projects')
    .select('id, key, title, description, status, task_counter')
    .eq('key', key.toUpperCase())
    .maybeSingle()
  return (data as Project) ?? null
}

/**
 * Every retired project key, with when it stopped being the key and what its
 * project is called now. The rename record is workspace-wide — the table's
 * primary key is the key itself — so, like `listFormerKeys`, this is not
 * filtered by owner. That module hands out the key only; the UI also needs the
 * date, because "was AC-113" is only true of a task filed before AC retired.
 */
export type FormerKeyRecord = {
  key: string
  project_id: string
  retired_at: string
  current: string
}

export const listFormerKeyRecords = async (): Promise<FormerKeyRecord[]> => {
  const { data, error } = await admin()
    .from('project_former_keys')
    .select('key, project_id, retired_at, project:projects(key)')
    .order('retired_at')

  if (error) throw new Error(error.message)
  type Row = Omit<FormerKeyRecord, 'current'> & {
    project: { key: string } | { key: string }[] | null
  }
  return ((data ?? []) as unknown as Row[]).map(({ project, ...row }) => ({
    ...row,
    current: (Array.isArray(project) ? project[0]?.key : project?.key) ?? '',
  }))
}

/**
 * Columns the board and list actually render. Deliberately NOT `select *`:
 * one imported project holds 691 tasks and 1.9MB of markdown descriptions,
 * and shipping all of that to the browser to render two clamped preview lines
 * is the difference between a snappy page and a multi-second one.
 *
 * `preview` is truncated server-side; the full body is only fetched on the
 * task detail page, where it is actually shown.
 */
const LIST_COLUMNS =
  'id, number, title, type, status, priority, labels, due_date, position, ' +
  'assignee_user_id, claimed_by, heartbeat_at, blocked_reason, external_ref, updated_at, ' +
  'resolution_kind, has_resolution, checkpoint_summary, preview:description'

export type TaskListItem = Pick<
  Task,
  | 'id' | 'number' | 'title' | 'type' | 'status' | 'priority' | 'labels'
  | 'due_date' | 'position' | 'assignee_user_id' | 'assignee' | 'claimed_by'
  | 'heartbeat_at' | 'blocked_reason' | 'updated_at'
> & {
  preview: string | null
  external_ref: string | null
  resolution_kind: string | null
  has_resolution: boolean
  checkpoint_summary: string | null
  /**
   * Present only on a task filed elsewhere and linked into this project. The
   * row keeps its own ref, so the list has to say which project that ref
   * belongs to — a row reading CROFT-83 in the HM list otherwise looks like a
   * bug. The list view already renders `project_key` when it is set, which is
   * why this reuses that field rather than adding a parallel one.
   */
  project_key?: string
  guest?: boolean
  /** The subject a todo belongs to, with its lab project. Null on an ordinary task. */
  subject?: LabTodoSubject | null
}

export type TaskPage = {
  tasks: TaskListItem[]
  total: number
  closedHidden: number
  recentlyClosed: TaskListItem[]
}

/**
 * The last few things finished, for the tab that asks "what just got done".
 *
 * Bounded and fetched separately rather than folded into the list: 94% of
 * tasks here are closed, so loading them to filter them client-side would mean
 * paying for two thousand rows to show forty. Ordered by when they were
 * actually resolved — `updated_at` moves when anything at all is touched, which
 * puts a task edited today above one finished this morning.
 */
const RECENTLY_CLOSED = 40
const CLOSED = ['done', 'cancelled']

/**
 * Ordered by when the work was actually finished.
 *
 * `updated_at` moves when anything at all is touched, so ordering by it puts a
 * task somebody edited today above one that was genuinely completed this
 * morning. Imported rows have no `resolved_at`, hence the fallback.
 */
const byWhenFinished = <T extends { order: (c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => T; limit: (n: number) => unknown }>(q: T) =>
  q
    .order('resolved_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(RECENTLY_CLOSED)

const PREVIEW_CHARS = 280

/**
 * Closed tasks are excluded by default. After importing years of history, 94%
 * of tasks are done — rendering them all by default would bury the handful
 * that are actually open.
 */
export const listTasks = async (
  projectId: string,
  { includeClosed = false, limit = 300 }: { includeClosed?: boolean; limit?: number },
  viewer: Viewer,
): Promise<TaskPage> => {
  const closedFilter = ['done', 'cancelled']
  // Every list and count below holds only what `viewer` may see.
  const visible = await visibleTasksOr(viewer.id)

  // Tasks filed elsewhere and linked here. The API route has included these
  // since cross-project links shipped; this did not, so `croft list --project HM`
  // and the HM page in a browser disagreed about what was in HM.
  const { data: links } = await admin()
    .from('task_projects')
    .select('task_id')
    .eq('project_id', projectId)
  const guestIds = (links ?? []).map((l) => l.task_id as string)

  const [openRows, guestRows, totals, closedRows] = await Promise.all([
    (() => {
      let q = restrictTo(admin().from('tasks').select(LIST_COLUMNS), visible)
        .eq('project_id', projectId)
      if (!includeClosed) q = q.not('status', 'in', `(${closedFilter.join(',')})`)
      return q.order('position').order('number', { ascending: false }).limit(limit)
    })(),
    (async () => {
      if (guestIds.length === 0) return { data: [] }
      let q = restrictTo(admin().from('tasks').select(`${LIST_COLUMNS}, project:projects!project_id!inner(key)`), visible)
        .in('id', guestIds)
      if (!includeClosed) q = q.not('status', 'in', `(${closedFilter.join(',')})`)
      return q.order('number', { ascending: false }).limit(limit)
    })(),
    restrictTo(admin().from('tasks').select('status', { count: 'exact', head: false }), visible)
      .eq('project_id', projectId),
    byWhenFinished(
      restrictTo(admin().from('tasks').select(LIST_COLUMNS), visible).eq('project_id', projectId).in('status', CLOSED),
    ),
  ])

  // Rows straight off the wire carry `assignee_user_id` but not the named
  // `assignee` — that is attached below, in bulk, by `withAssignees`.
  type RawListItem = Omit<TaskListItem, 'assignee'>

  const all = (totals.data ?? []) as { status: string }[]
  const clip = <T extends { preview: string | null }>(t: T): T => ({
    ...t,
    preview: t.preview ? t.preview.slice(0, PREVIEW_CHARS) : null,
  })

  const owned = ((openRows.data ?? []) as unknown as RawListItem[]).map(clip)

  const guests = (
    (guestRows.data ?? []) as unknown as (RawListItem & {
      project: { key: string } | { key: string }[]
    })[]
  ).map((t) => ({
    ...clip(t),
    project_key: (Array.isArray(t.project) ? t.project[0]?.key : t.project?.key) ?? undefined,
    guest: true,
  }))

  const [tasks, recentlyClosed] = await Promise.all([
    withAssignees([...owned, ...guests]).then((rows) => withTaskSubjects(rows, viewer.id)),
    withAssignees((((closedRows as { data?: unknown }).data ?? []) as RawListItem[]).map(clip)).then((rows) =>
      withTaskSubjects(rows, viewer.id),
    ),
  ])

  return {
    tasks,
    total: all.length + guests.length,
    closedHidden: includeClosed ? 0 : all.filter((t) => closedFilter.includes(t.status)).length,
    recentlyClosed,
  }
}

/**
 * The projects a task is linked into beyond the one that owns its ref. Keys
 * only — the detail panel needs to render them and toggle them, not join them.
 */
export const listAlsoProjects = async (taskId: string, viewer: Viewer): Promise<string[]> => {
  if (!(await isTaskIdVisible(taskId, viewer.id))) return []
  const { data } = await admin()
    .from('task_projects')
    .select('project:projects(key)')
    .eq('task_id', taskId)

  return ((data ?? []) as unknown as { project: { key: string } | { key: string }[] | null }[])
    .map((r) => (Array.isArray(r.project) ? r.project[0]?.key : r.project?.key))
    .filter((k): k is string => Boolean(k))
    .sort()
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
  return await withAssignee({ ...row, subject })
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

export type Attachment = {
  id: string
  original_name: string
  mime_type: string
  size_bytes: number
  actor_id: string
  created_at: string
}

export const listAttachments = async (taskId: string, viewer: Viewer): Promise<Attachment[]> => {
  if (!(await isTaskIdVisible(taskId, viewer.id))) return []
  const { data } = await admin()
    .from('task_attachments')
    .select('id, original_name, mime_type, size_bytes, actor_id, created_at')
    .eq('task_id', taskId)
    .order('created_at')
  return (data ?? []) as Attachment[]
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

/**
 * Every task the user owns, across all projects.
 *
 * The single most-missed view: with 34 projects, "what is open anywhere?"
 * cannot be answered by visiting each one. Same lightweight projection as the
 * per-project list — no descriptions — plus the project key, which is the
 * column that only matters when the list spans projects.
 */
export const listAllTasks = async (
  _userId: string,
  {
    includeClosed = false,
    limit = 500,
  }: { includeClosed?: boolean; limit?: number },
  viewer: Viewer,
): Promise<{
  tasks: (TaskListItem & { project_key: string })[]
  closedHidden: number
  recentlyClosed: (TaskListItem & { project_key: string })[]
}> => {
  const closed = ['done', 'cancelled']
  const visible = await visibleTasksOr(viewer.id)

  let q = restrictTo(admin().from('tasks').select(`${LIST_COLUMNS}, project:projects!project_id!inner(key)`), visible)

  if (!includeClosed) q = q.not('status', 'in', `(${closed.join(',')})`)

  const [rows, totals, closedRows] = await Promise.all([
    q.order('updated_at', { ascending: false }).limit(limit),
    restrictTo(admin().from('tasks').select('id', { count: 'exact', head: true }), visible).in('status', closed),
    byWhenFinished(
      restrictTo(admin().from('tasks').select(`${LIST_COLUMNS}, project:projects!project_id!inner(key)`), visible)
        .in('status', closed),
    ),
  ])

  type Row = TaskListItem & { project: { key: string } | { key: string }[] }
  const tasks = ((rows.data ?? []) as unknown as Row[]).map((t) => ({
    ...t,
    preview: t.preview ? t.preview.slice(0, PREVIEW_CHARS) : null,
    project_key: (Array.isArray(t.project) ? t.project[0]?.key : t.project?.key) ?? '',
  }))

  const withKey = (t: Row) => ({
    ...t,
    preview: t.preview ? t.preview.slice(0, PREVIEW_CHARS) : null,
    project_key: (Array.isArray(t.project) ? t.project[0]?.key : t.project?.key) ?? '',
  })

  // Named in one query across both lists. Without it every row on the home
  // page drew its assignee as "?": the id came back, the person never did.
  const recent = (((closedRows as { data?: unknown }).data ?? []) as Row[]).map(withKey)
  const named = await withTaskSubjects(await withAssignees([...tasks, ...recent]), viewer.id)

  return {
    tasks: named.slice(0, tasks.length),
    closedHidden: includeClosed ? 0 : (totals.count ?? 0),
    recentlyClosed: named.slice(tasks.length),
  }
}


export type Relation = {
  id: string
  number: number
  title: string
  status: string
  project_key: string
  direction: 'blocked-by' | 'blocks'
}

/**
 * Task relationships, both directions.
 *
 * task_deps has been written by the API since the first migration and
 * rendered nowhere — so "this is waiting on that" existed in the data and was
 * invisible to the person deciding what to pick up.
 */
export const listRelations = async (taskId: string, viewer: Viewer): Promise<Relation[]> => {
  if (!(await isTaskIdVisible(taskId, viewer.id))) return []
  const shape = 'blocked_id, blocking_id'
  const [blockedBy, blocks] = await Promise.all([
    admin().from('task_deps').select(shape).eq('blocked_id', taskId),
    admin().from('task_deps').select(shape).eq('blocking_id', taskId),
  ])

  const ids = [
    ...((blockedBy.data ?? []) as { blocking_id: string }[]).map((r) => ({
      id: r.blocking_id,
      direction: 'blocked-by' as const,
    })),
    ...((blocks.data ?? []) as { blocked_id: string }[]).map((r) => ({
      id: r.blocked_id,
      direction: 'blocks' as const,
    })),
  ]
  if (ids.length === 0) return []

  // A link to a task the viewer cannot see is not shown.
  const { data } = await restrictTo(
    admin().from('tasks').select('id, number, title, status, project:projects!project_id!inner(key)'),
    await visibleTasksOr(viewer.id),
  ).in('id', ids.map((i) => i.id))

  type Row = { id: string; number: number; title: string; status: string; project: { key: string } | { key: string }[] }
  return ((data ?? []) as unknown as Row[]).map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    project_key: (Array.isArray(row.project) ? row.project[0]?.key : row.project?.key) ?? '',
    direction: ids.find((i) => i.id === row.id)?.direction ?? 'blocked-by',
  }))
}

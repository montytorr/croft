import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import { TODO_PROJECT_KEY, type LabTodo } from '@/lib/lab/types'
import { withHandoff } from './handoff-shape'
import { findLabProject, unknownLabProject } from './lab-admin'
import { noSuchSubject, resolveSubject } from './subjects'
import { subjectVisibleSql, taskVisibleSql } from './visibility'

/**
 * Todos as the lab shows them: each task with the subject it belongs to and
 * that subject's lab project, so /todos and /board can say what a todo is
 * for without a second lookup per row.
 */

export type LabTodoSubject = NonNullable<LabTodo['subject']>

const CLOSED = ['done', 'cancelled']

const SUBJECT_JSON = `
  case when s.id is null then null
       else json_build_object(
         'ref', 'S-' || s.number, 'number', s.number, 'title', s.title, 'visibility', s.visibility,
         'project', case when lp.id is null then null
                         else json_build_object('name', lp.name, 'color', lp.color) end)
  end`

/**
 * The `subject` of each row, by task id, in one query. Rows keep every field
 * they had; `subject` is added (null on a task that belongs to no subject).
 *
 * A decoration, not a filter: callers have already kept to the tasks
 * `viewerId` may see. A subject the viewer may not see is still never named.
 */
export const withTaskSubjects = async <T extends { id: string }>(
  tasks: readonly T[],
  viewerId: string,
): Promise<(T & { subject: LabTodoSubject | null })[]> => {
  const ids = [...new Set(tasks.map((t) => t.id))]
  if (ids.length === 0) return tasks.map((t) => ({ ...t, subject: null }))
  const result = await pool().query(
    `select t.id, ${SUBJECT_JSON} as subject
       from tasks t
       join subjects s on s.id = t.subject_id
       left join lab_projects lp on lp.id = s.project_id
      where t.id = any($1::uuid[]) and ${subjectVisibleSql('s.id', '$2')}`,
    [ids, viewerId],
  )
  const bySubject = new Map(
    (normalizeDatabaseValue(result.rows) as { id: string; subject: LabTodoSubject }[]).map((r) => [r.id, r.subject]),
  )
  return tasks.map((t) => ({ ...t, subject: bySubject.get(t.id) ?? null }))
}

export type LabTodoFilters = {
  /** `S-12`, `12` or the subject's id. */
  subject?: string
  /** A lab project name or id, `none` (a subject in no project, or no subject), or a comma list. */
  project?: string
}

/** Resolved filters: the subject's id, and the subjects the project filter admits. */
export type ResolvedTodoFilters = {
  subjectId?: string
  project?: { subjectIds: string[]; none: boolean }
}

/**
 * Turns `?subject=` and `?project=` into ids, or a refusal that names what
 * does exist — the same `not_found` a subject route answers, and the list of
 * lab projects `unknownLabProject` gives.
 */
export const resolveTodoFilters = async (
  filters: LabTodoFilters,
  viewerId: string,
): Promise<{ ok: true; value: ResolvedTodoFilters } | { ok: false; response: Response }> => {
  const value: ResolvedTodoFilters = {}
  if (filters.subject) {
    // A subject the viewer cannot see is refused exactly as one that does not exist.
    const subject = await resolveSubject(filters.subject, viewerId)
    if (!subject) return { ok: false, response: noSuchSubject(filters.subject) }
    value.subjectId = subject.id
  }
  const names = (filters.project ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  if (names.length) {
    const none = names.some((n) => n.toLowerCase() === 'none')
    const projectIds: string[] = []
    for (const name of names.filter((n) => n.toLowerCase() !== 'none')) {
      const project = await findLabProject(name)
      if (!project) return { ok: false, response: await unknownLabProject(name) }
      projectIds.push(project.id)
    }
    const found = await pool().query<{ id: string }>(
      `select s.id from subjects s
        where (s.project_id = any($1::uuid[]) or ($2 and s.project_id is null))
          and ${subjectVisibleSql('s.id', '$3')}`,
      [projectIds, none, viewerId],
    )
    value.project = { subjectIds: found.rows.map((r) => r.id), none }
  }
  return { ok: true, value }
}

type Row = Omit<LabTodo, 'ref' | 'assignee' | 'handoff' | 'cairn_ref' | 'cairn_status'> & {
  key: string
  assignee_id: string | null
  assignee_name: string | null
}

export type ListLabTodosOptions = LabTodoFilters & {
  /** Done and cancelled too. Off by default: most todos, like most tasks, end up closed. */
  includeClosed?: boolean
  status?: string
  limit?: number
}

/**
 * Every todo — every task in project T — with its subject. Open ones first,
 * then the most recently touched. Unknown filters resolve to an empty list;
 * a route wanting a readable refusal calls `resolveTodoFilters` first.
 */
export const listLabTodos = async (options: ListLabTodosOptions, viewerId: string): Promise<LabTodo[]> => {
  const resolved = await resolveTodoFilters(options, viewerId)
  if (!resolved.ok) return []
  const { subjectId, project } = resolved.value

  const values: unknown[] = [TODO_PROJECT_KEY, viewerId]
  const bind = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }
  const where = ['p.key = $1', taskVisibleSql('t.subject_id', '$2')]
  if (!options.includeClosed && !options.status) where.push(`t.status <> all(${bind(CLOSED)}::text[])`)
  if (options.status) where.push(`t.status = ${bind(options.status)}`)
  if (subjectId) where.push(`t.subject_id = ${bind(subjectId)}::uuid`)
  if (project) {
    where.push(
      `(t.subject_id = any(${bind(project.subjectIds)}::uuid[])${project.none ? ' or t.subject_id is null' : ''})`,
    )
  }

  const result = await pool().query(
    `select t.id, t.number, p.key, t.title, t.status, t.priority, t.claimed_by, t.handoff_tracker, t.handoff_ref,
            t.handoff_url, t.handoff_status, t.handoff_synced_at, t.updated_at, u.id as assignee_id,
            coalesce(nullif(trim(up.display_name), ''), u.email) as assignee_name,
            ${SUBJECT_JSON} as subject
       from tasks t
       join projects p on p.id = t.project_id
       left join subjects s on s.id = t.subject_id
       left join lab_projects lp on lp.id = s.project_id
       left join app_users u on u.id = t.assignee_user_id
       left join user_profiles up on up.id = u.id
      where ${where.join(' and ')}
      order by (t.status = any(${bind(CLOSED)}::text[])), t.updated_at desc, t.number desc
      limit ${bind(Math.min(Math.max(options.limit ?? 500, 1), 2000))}`,
    values,
  )
  return (normalizeDatabaseValue(result.rows) as Row[]).map(({ key, assignee_id, assignee_name, ...todo }) => ({
    ...(withHandoff(todo) as unknown as Omit<LabTodo, 'ref' | 'assignee'>),
    ref: `${key}-${todo.number}`,
    assignee: assignee_id ? { id: assignee_id, name: assignee_name ?? '' } : null,
  }))
}

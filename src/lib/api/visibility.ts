import { pool } from '@/lib/db/client'
import type { UserRole } from './actor'

/**
 * Who is looking (v0.4, private & member-scoped subjects).
 *
 * A subject is `lab` (everyone), `members` (its owner and the people it was
 * shared with) or `private` (its owner). Todos inherit their subject's
 * visibility. The rule itself lives in SQL — `croft_subject_visible` and
 * `croft_task_visible` (migration 076) — so every read path, TS or SQL, asks
 * the same question and gets the same answer. This module is the TS side:
 * the fragments and lookups that put those helpers in front of a query.
 *
 * Hidden is missing. Every caller treats a subject or task the viewer cannot
 * see exactly as one that does not exist: the same `not_found`, the same
 * message, the same empty list, counts that do not include it.
 */

export type Viewer = { id: string; role: UserRole }

export const viewerOf = (actor: { userId: string; role: UserRole }): Viewer => ({ id: actor.userId, role: actor.role })

/** `croft_subject_visible(<column>, <param>::uuid)`, for a pool() query. */
export const subjectVisibleSql = (subjectColumn: string, viewerParam: string) =>
  `croft_subject_visible(${subjectColumn}, ${viewerParam}::uuid)`

/** `croft_task_visible(<column>, <param>::uuid)`: true for a task that belongs to no subject. */
export const taskVisibleSql = (subjectIdColumn: string, viewerParam: string) =>
  `croft_task_visible(${subjectIdColumn}, ${viewerParam}::uuid)`

export const isSubjectVisible = async (subjectId: string, viewerId: string): Promise<boolean> => {
  const result = await pool().query<{ v: boolean }>('select croft_subject_visible($1::uuid, $2::uuid) as v', [
    subjectId,
    viewerId,
  ])
  return result.rows[0]?.v === true
}

/** A task's visibility from its `subject_id`, without a query when it has none. */
export const isTaskVisible = async (subjectId: unknown, viewerId: string): Promise<boolean> => {
  if (subjectId === null || subjectId === undefined || subjectId === '') return true
  if (typeof subjectId !== 'string') return false
  return isSubjectVisible(subjectId, viewerId)
}

/** Of `taskIds`, the ones the viewer may see. A missing id is not visible. */
export const visibleTaskIds = async (taskIds: readonly string[], viewerId: string): Promise<Set<string>> => {
  const unique = [...new Set(taskIds.filter(Boolean))]
  if (unique.length === 0) return new Set()
  const result = await pool().query<{ id: string }>(
    `select t.id from tasks t where t.id = any($1::uuid[]) and ${taskVisibleSql('t.subject_id', '$2')}`,
    [unique, viewerId],
  )
  return new Set(result.rows.map((r) => r.id))
}

/** Of `subjectIds`, the ones the viewer may see. */
export const visibleSubjectIds = async (subjectIds: readonly string[], viewerId: string): Promise<Set<string>> => {
  const unique = [...new Set(subjectIds.filter(Boolean))]
  if (unique.length === 0) return new Set()
  const result = await pool().query<{ id: string }>(
    `select s.id from subjects s where s.id = any($1::uuid[]) and ${subjectVisibleSql('s.id', '$2')}`,
    [unique, viewerId],
  )
  return new Set(result.rows.map((r) => r.id))
}

/**
 * The PostgREST-style `or` expression that admits only the tasks the viewer
 * may see, for `admin()` builder queries on `tasks`: no subject, or a subject
 * in the visible set. `null` when nothing is hidden from this viewer, so the
 * common case (every subject in the lab) costs one cheap query and no filter.
 *
 * Only subjects that have todos are listed, which keeps the list short.
 */
export const visibleTasksOr = async (viewerId: string, column = 'subject_id'): Promise<string | null> => {
  const result = await pool().query<{ hidden: number; visible: string[] | null }>(
    // Every hidden subject counts, todos or not: counting only those with
    // todos turned the filter off while a private subject was still empty,
    // and a first todo filed before this request's own query ran showed.
    `select count(*) filter (where not v)::int as hidden,
            array_agg(id) filter (where v and has_todos) as visible
       from (select s.id, ${subjectVisibleSql('s.id', '$1')} as v,
                    exists (select 1 from tasks t where t.subject_id = s.id) as has_todos
               from subjects s) x`,
    [viewerId],
  )
  const row = result.rows[0]
  if (!row || row.hidden === 0) return null
  const visible = row.visible ?? []
  return visible.length ? `${column}.is.null,${column}.in.(${visible.join(',')})` : `${column}.is.null`
}

/**
 * Applies an expression from `visibleTasksOr` to a builder query. Synchronous
 * on purpose: the builder is a thenable, so handing it through an async
 * function would run it instead of returning it.
 */
export const restrictTo = <Q extends { or: (expression: string) => Q }>(query: Q, expression: string | null): Q =>
  expression ? query.or(expression) : query

/** Whether the task with this id exists and the viewer may see it. */
export const isTaskIdVisible = async (taskId: string, viewerId: string): Promise<boolean> =>
  (await visibleTaskIds([taskId], viewerId)).has(taskId)

/**
 * A task row with its `parent_id` and `duplicate_of` blanked when they point
 * at a task the viewer may not see. A lab task can hang under, or duplicate,
 * a private todo (its owner sees both), and the bare uuid would tell everyone
 * else that a hidden task exists — a missing one would be null.
 */
export const withoutHiddenLinks = async <T>(row: T, viewerId: string): Promise<T> => {
  if (!row || typeof row !== 'object') return row
  const record = row as Record<string, unknown>
  const links = (['parent_id', 'duplicate_of'] as const).filter((column) => typeof record[column] === 'string')
  if (links.length === 0) return row
  const visible = await visibleTaskIds(links.map((column) => record[column] as string), viewerId)
  const hidden = links.filter((column) => !visible.has(record[column] as string))
  return hidden.length ? ({ ...record, ...Object.fromEntries(hidden.map((column) => [column, null])) } as T) : row
}

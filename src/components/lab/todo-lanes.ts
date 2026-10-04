import type { LabTodo, SubjectTodo } from '@/lib/lab/types'
import { TASK_STATUSES, isTerminal, type TaskStatus } from '@/schemas/task'

/** A subject's todo as its page shows it; priority and assignee when the loader provides them. */
export type PageTodo = SubjectTodo & Partial<Pick<LabTodo, 'priority' | 'assignee'>>

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'Doing',
  'in-review': 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
}

const asStatus = (status: string): TaskStatus =>
  (TASK_STATUSES as readonly string[]).includes(status) ? (status as TaskStatus) : 'todo'

/**
 * The board's lanes, left to right: todo · doing · in review · done always;
 * backlog only when something is in it, and cancelled only when asked for.
 */
export const boardLanes = (todos: Pick<SubjectTodo, 'status'>[], showCancelled: boolean): TaskStatus[] => {
  const present = new Set(todos.map((t) => asStatus(t.status)))
  return TASK_STATUSES.filter(
    (s) => s === 'todo' || s === 'doing' || s === 'in-review' || s === 'done' || (s === 'backlog' && present.has(s)) || (s === 'cancelled' && showCancelled),
  )
}

/** The list's groups: work in hand first, then what is waiting, then what is settled. Empty groups are left out. */
const LIST_ORDER: TaskStatus[] = ['doing', 'in-review', 'todo', 'backlog', 'done', 'cancelled']

export const listGroups = <T extends Pick<SubjectTodo, 'status'>>(todos: T[], showCancelled: boolean) =>
  LIST_ORDER.filter((s) => s !== 'cancelled' || showCancelled)
    .map((status) => ({ status, todos: todos.filter((t) => asStatus(t.status) === status) }))
    .filter((group) => group.todos.length > 0)

export const laneOf = (todo: Pick<SubjectTodo, 'status'>) => asStatus(todo.status)

/**
 * Whether a move needs a resolution first. A todo in Done or Cancelled already
 * carries one, so moving between those two does not ask again; the server
 * clears it when a todo is reopened, so anything open is assumed to have none.
 */
export const needsResolution = (from: string, to: TaskStatus) => isTerminal(to) && !isTerminal(asStatus(from))

/** A handed-off todo lives in another tracker: its status is that tracker's, and nothing here moves it. */
export const isHandedOff = (todo: Pick<SubjectTodo, 'handoff'>) => Boolean(todo.handoff)

export const counts = (todos: Pick<SubjectTodo, 'status'>[]) => {
  const done = todos.filter((t) => t.status === 'done').length
  const cancelled = todos.filter((t) => t.status === 'cancelled').length
  return { open: todos.length - done - cancelled, done, cancelled }
}

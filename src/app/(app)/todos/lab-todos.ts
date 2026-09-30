import { parseSubjectRef, type LabTodo } from '@/lib/lab/types'

/**
 * Pure filtering, grouping and URL logic for `/todos`, kept free of React so
 * it can be tested directly — the same split as `src/lib/board-state.ts`.
 */

export const TODO_GROUPS = ['status', 'subject', 'none'] as const
export type TodoGroup = (typeof TODO_GROUPS)[number]

export type TodosView = {
  /** A lab project's name (any case), `none` for todos whose subject has none, or '' for all. */
  project: string
  /** A subject ref (`S-12`), `none` for todos on no subject, or '' for all. */
  subject: string
  group: TodoGroup
  /** Done and cancelled shown too. */
  closed: boolean
}

export const DEFAULT_TODOS_VIEW: TodosView = { project: '', subject: '', group: 'status', closed: false }

const CLOSED = new Set(['done', 'cancelled'])
export const isClosed = (status: string) => CLOSED.has(status)

/** The order a list reads in: what is moving first, what is finished last. */
export const STATUS_ORDER = ['doing', 'in-review', 'todo', 'backlog', 'done', 'cancelled'] as const
const statusRank = (status: string) => {
  const i = (STATUS_ORDER as readonly string[]).indexOf(status)
  return i < 0 ? STATUS_ORDER.length : i
}

/** `s-3` and `3` read as `S-3`, so the picker shows what the URL filters by; anything else is kept as typed. */
export const normaliseSubjectParam = (value: string) => {
  const n = parseSubjectRef(value)
  return n === null ? value : `S-${n}`
}

export const parseTodosView = (search: string | URLSearchParams): TodosView => {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const group = params.get('group') ?? ''
  return {
    project: params.get('project')?.trim() ?? '',
    subject: normaliseSubjectParam(params.get('subject')?.trim() ?? ''),
    group: (TODO_GROUPS as readonly string[]).includes(group) ? (group as TodoGroup) : DEFAULT_TODOS_VIEW.group,
    closed: params.get('closed') === '1',
  }
}

/** The inverse of `parseTodosView`, leaving defaults out so a plain `/todos` stays plain. */
export const serializeTodosView = (view: TodosView): string => {
  const params = new URLSearchParams()
  if (view.project) params.set('project', view.project)
  if (view.subject) params.set('subject', view.subject)
  if (view.group !== DEFAULT_TODOS_VIEW.group) params.set('group', view.group)
  if (view.closed) params.set('closed', '1')
  return params.toString()
}

export const todosHref = (view: TodosView) => {
  const qs = serializeTodosView(view)
  return qs ? `/todos?${qs}` : '/todos'
}

/** Whether a todo belongs to a lab-project filter value (`''` matches everything). */
export const inProject = (todo: Pick<LabTodo, 'subject'>, project: string) => {
  if (!project) return true
  const name = todo.subject?.project?.name
  if (project.toLowerCase() === 'none') return !name
  return name?.toLowerCase() === project.toLowerCase()
}

/** Whether a todo belongs to a subject filter value (`''` matches everything). */
export const onSubject = (todo: Pick<LabTodo, 'subject'>, subject: string) => {
  if (!subject) return true
  if (subject.toLowerCase() === 'none') return !todo.subject
  const number = parseSubjectRef(subject)
  return number !== null && todo.subject?.number === number
}

export const matchesTodosView = (todo: LabTodo, view: TodosView) =>
  (view.closed || !isClosed(todo.status)) && inProject(todo, view.project) && onSubject(todo, view.subject)

type Subject = NonNullable<LabTodo['subject']>

export type TodoGroupDef =
  | { kind: 'status'; key: string; status: string; todos: LabTodo[] }
  | { kind: 'subject'; key: string; subject: Subject | null; todos: LabTodo[] }
  | { kind: 'all'; key: string; todos: LabTodo[] }

const byRecent = (a: LabTodo, b: LabTodo) => b.updated_at.localeCompare(a.updated_at)
const byStatusThenRecent = (a: LabTodo, b: LabTodo) => statusRank(a.status) - statusRank(b.status) || byRecent(a, b)

/**
 * Subjects in a stable order: grouped by lab project (by name, no project
 * last), newest subject first within each; todos on no subject at the end.
 */
const subjectOrder = (a: Subject | null, b: Subject | null) => {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  const pa = a.project?.name
  const pb = b.project?.name
  if (pa !== pb) {
    if (!pa) return 1
    if (!pb) return -1
    return pa.localeCompare(pb)
  }
  return b.number - a.number
}

export const groupTodos = (todos: LabTodo[], group: TodoGroup): TodoGroupDef[] => {
  if (group === 'none') return todos.length ? [{ kind: 'all', key: 'all', todos: [...todos].sort(byStatusThenRecent) }] : []

  if (group === 'status') {
    const by = new Map<string, LabTodo[]>()
    for (const t of todos) by.set(t.status, [...(by.get(t.status) ?? []), t])
    return [...by.entries()]
      .sort(([a], [b]) => statusRank(a) - statusRank(b) || a.localeCompare(b))
      .map(([status, list]) => ({ kind: 'status', key: status, status, todos: list.sort(byRecent) }))
  }

  const by = new Map<string, { subject: Subject | null; todos: LabTodo[] }>()
  for (const t of todos) {
    const key = t.subject?.ref ?? 'none'
    const entry = by.get(key) ?? { subject: t.subject, todos: [] }
    entry.todos.push(t)
    by.set(key, entry)
  }
  return [...by.entries()]
    .sort(([, a], [, b]) => subjectOrder(a.subject, b.subject))
    .map(([key, { subject, todos: list }]) => ({ kind: 'subject', key, subject, todos: list.sort(byStatusThenRecent) }))
}

/** Every subject that has a todo, in the grouping's order, for the subject picker. */
export const subjectsOf = (todos: LabTodo[]): Subject[] => {
  const seen = new Map<string, Subject>()
  for (const t of todos) if (t.subject) seen.set(t.subject.ref, t.subject)
  return [...seen.values()].sort(subjectOrder)
}

/** Open todos per lab project name (lower-cased), `none` for no project. */
export const openCountsByProject = (todos: LabTodo[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const t of todos) {
    if (isClosed(t.status)) continue
    const key = t.subject?.project?.name.toLowerCase() ?? 'none'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

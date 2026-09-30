'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Avatar, PriorityIcon, StatusIcon } from '@/components/icons'
import { EmptyState } from '@/components/empty-state'
import { Select } from '@/components/ui/control'
import { ProjectLabel } from '@/components/lab/project-label'
import { fullDateTime, shortDate } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { TASK_STATUSES, isTerminal, type TaskPriority, type TaskStatus } from '@/schemas/task'
import { TODO_PROJECT_KEY, type LabProject, type LabTodo } from '@/lib/lab/types'
import { QuickSelect, useQuickPatch } from '../projects/[key]/quick-edit'
import { ResolutionDialog } from '../projects/[key]/resolution-dialog'
import { CairnBadge, ProjectDot, SubjectChip } from './todo-bits'
import {
  groupTodos,
  isClosed,
  matchesTodosView,
  openCountsByProject,
  parseTodosView,
  subjectsOf,
  todosHref,
  type TodoGroup,
  type TodoGroupDef,
  type TodosView as View,
} from './lab-todos'

const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'Doing',
  'in-review': 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
}

const GROUP_LABEL: Record<TodoGroup, string> = { status: 'Status', subject: 'Subject', none: 'None' }

/** A filter chip: one height and one pressed look for every choice on the bar. */
const CHIP = cn(
  'inline-flex h-[1.5rem] shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[0.71875rem]',
  'transition-[color,background-color,opacity] duration-[var(--dur-1)] ease-[var(--ease-out)]',
)

/**
 * The status badge, changeable in place. A pushed todo is Cairn's to move, so
 * it shows its status and offers nothing; closing asks how it ended first,
 * because the API refuses a close without a resolution.
 */
const StatusControl = ({ todo }: { todo: LabTodo }) => {
  const { patch, overlay, error, clearError } = useQuickPatch(todo.ref, todo.updated_at)
  const [closing, setClosing] = useState<TaskStatus | null>(null)
  const status = ((overlay?.status as string) ?? todo.status) as TaskStatus

  if (todo.cairn_ref) {
    return (
      <span className="relative z-10 inline-flex shrink-0 opacity-70" title={`${STATUS_LABEL[status] ?? status} · pushed to Cairn, moved there`}>
        <StatusIcon status={status} size={13} />
      </span>
    )
  }

  return (
    <>
      <QuickSelect
        value={status}
        options={TASK_STATUSES}
        labels={STATUS_LABEL}
        title={`Status: ${STATUS_LABEL[status] ?? status}`}
        onChange={(next) => {
          if (isTerminal(next)) {
            setClosing(next)
            return
          }
          void patch({ status: next })
        }}
        className="pointer-events-auto"
      >
        <StatusIcon status={status} size={13} />
      </QuickSelect>
      {error ? (
        <button type="button" onClick={clearError} title={error} className="text-danger pointer-events-auto relative z-10 shrink-0 text-[0.6875rem]">
          refused
        </button>
      ) : null}
      {closing && (
        <ResolutionDialog
          taskTitle={todo.title}
          status={closing}
          suggestion={null}
          onCancel={() => setClosing(null)}
          onConfirm={async (resolution, kind, duplicateOf) => {
            const ok = await patch({ status: closing, resolution, resolutionKind: kind, ...(duplicateOf ? { duplicateOf } : {}) })
            if (ok) setClosing(null)
            return ok
          }}
        />
      )}
    </>
  )
}

const Row = ({ todo, showSubject }: { todo: LabTodo; showSubject: boolean }) => {
  const closed = isClosed(todo.status)
  const loud = todo.priority === 'urgent' || todo.priority === 'high'

  return (
    <li className="row-hover group relative flex h-[1.875rem] items-center gap-2 pr-3 pl-3 md:pr-4 md:pl-4">
      {/* The whole row opens the todo; the badges on it are raised above this link. */}
      <Link
        href={`/projects/${TODO_PROJECT_KEY}/tasks/${todo.number}`}
        prefetch
        aria-label={todo.title}
        className="absolute inset-0 z-0"
      />
      <StatusControl todo={todo} />
      <code className="text-fg-subtle tabular hidden w-[3.25rem] shrink-0 truncate text-[0.6875rem] sm:block">{todo.ref}</code>
      {loud ? (
        <span className="shrink-0" title={`Priority: ${todo.priority}`}>
          <PriorityIcon priority={todo.priority as TaskPriority} />
        </span>
      ) : null}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[0.8125rem]',
          closed ? 'text-fg-subtle decoration-fg-subtle/40 line-through' : 'text-fg',
        )}
      >
        {todo.title}
      </span>

      {showSubject && todo.subject ? (
        <SubjectChip
          subject={todo.subject}
          className="max-w-[40%] shrink sm:max-w-[16rem]"
          titleClassName="hidden sm:inline"
        />
      ) : null}

      <CairnBadge cairnRef={todo.cairn_ref} cairnStatus={todo.cairn_status} className="relative z-10 hidden md:inline-flex" />

      {todo.claimed_by ? (
        <span className="relative z-10 shrink-0" title={`Held by ${todo.claimed_by}`}>
          <Avatar name={todo.claimed_by} size={16} />
        </span>
      ) : null}
      {todo.assignee ? (
        <span className="relative z-10 hidden shrink-0 sm:inline-flex" title={`Assignee: ${todo.assignee.name}`}>
          <Avatar name={todo.assignee.name} size={16} />
        </span>
      ) : null}

      <time
        dateTime={todo.updated_at}
        title={fullDateTime(todo.updated_at)}
        className="text-fg-subtle tabular hidden w-[2.75rem] shrink-0 text-right text-[0.6875rem] md:block"
      >
        {shortDate(todo.updated_at)}
      </time>
    </li>
  )
}

const GroupHeading = ({ group }: { group: TodoGroupDef }) => {
  const open = group.todos.filter((t) => !isClosed(t.status)).length
  const done = group.todos.length - open
  const tally = (
    <span className="text-fg-subtle tabular ml-auto shrink-0 text-[0.6875rem]">
      {done > 0 ? `${open} open · ${done} closed` : group.todos.length}
    </span>
  )

  const shell = 'bg-bg border-border sticky top-0 z-[5] flex h-[1.75rem] items-center gap-2 border-b px-3 md:px-4'

  if (group.kind === 'status') {
    return (
      <h2 className={shell}>
        <StatusIcon status={group.status as TaskStatus} size={12} />
        <span className="text-fg-muted text-[0.71875rem] font-medium">{STATUS_LABEL[group.status] ?? group.status}</span>
        {tally}
      </h2>
    )
  }

  if (group.kind === 'subject') {
    const { subject } = group
    return (
      <h2 className={shell}>
        {subject ? (
          <Link href={`/subjects/${subject.number}`} className="group/h flex min-w-0 items-center gap-2">
            <ProjectDot color={subject.project?.color} />
            <span className="text-fg-subtle shrink-0 font-mono text-[0.6875rem]">{subject.ref}</span>
            <span className="text-fg group-hover/h:text-accent min-w-0 truncate text-[0.75rem] font-medium transition-colors">
              {subject.title}
            </span>
            {subject.project ? (
              <span className="text-fg-subtle hidden shrink-0 text-[0.6875rem] sm:inline">{subject.project.name}</span>
            ) : null}
          </Link>
        ) : (
          <span className="text-fg-muted text-[0.71875rem] font-medium">No subject</span>
        )}
        {tally}
      </h2>
    )
  }

  return null
}

/**
 * Every lab todo, each carrying its subject. Filters and grouping are in the
 * URL, applied here so a click answers at once; the address bar follows with
 * `replaceState`, so a view can be shared without a round trip per chip.
 */
export const TodosView = ({
  todos,
  projects,
  initialQuery,
}: {
  todos: LabTodo[]
  projects: Pick<LabProject, 'id' | 'name' | 'color'>[]
  /** The request's query string, so the server renders the view the client hydrates. */
  initialQuery: string
}) => {
  const [view, setViewState] = useState<View>(() => parseTodosView(initialQuery))

  const setView = (patch: Partial<View>) => {
    const next = { ...view, ...patch }
    setViewState(next)
    if (typeof window !== 'undefined') window.history.replaceState(null, '', todosHref(next))
  }

  const counts = useMemo(() => openCountsByProject(todos), [todos])
  const inProjectView = useMemo(
    () => todos.filter((t) => matchesTodosView(t, { ...view, subject: '', closed: true })),
    [todos, view],
  )
  const subjects = useMemo(() => subjectsOf(inProjectView), [inProjectView])
  const visible = useMemo(() => todos.filter((t) => matchesTodosView(t, view)), [todos, view])
  const groups = useMemo(() => groupTodos(visible, view.group), [visible, view.group])
  const closedCount = useMemo(
    () => todos.filter((t) => isClosed(t.status) && matchesTodosView(t, { ...view, closed: true })).length,
    [todos, view],
  )

  const projectOn = (name: string) => view.project.toLowerCase() === name.toLowerCase()
  const noProjectCount = counts.get('none') ?? 0
  const filtered = Boolean(view.project || view.subject)

  if (todos.length === 0) {
    return (
      <EmptyState
        as="h1"
        title="No todos yet"
        hint="Todos belong to subjects. Open a subject in the lab and add the first one, or from the CLI:"
        action={
          <pre className="surface-card max-w-full overflow-x-auto px-3 py-2.5 text-left font-mono text-[0.75rem]">
            {`croft subject todo S-1 "try it on the staging data"`}
          </pre>
        }
      />
    )
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Wraps rather than scrolls: a scroll container here would clip the
          subject picker's native popup on some platforms, and a phone gets
          two short rows instead of one it has to swipe. */}
      <div className="border-border flex flex-wrap items-center gap-x-1 gap-y-1.5 border-b px-3 py-1.5 md:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-0.5" role="group" aria-label="Filter by project">
          <button
            type="button"
            onClick={() => setView({ project: '', subject: '' })}
            aria-pressed={!view.project}
            className={cn(CHIP, !view.project ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-hover')}
          >
            All
          </button>
          {projects.map((p) => {
            const on = projectOn(p.name)
            const count = counts.get(p.name.toLowerCase()) ?? 0
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setView({ project: on ? '' : p.name, subject: '' })}
                aria-pressed={on}
                className={cn(CHIP, 'px-0.5', view.project && !on && 'opacity-60 hover:opacity-100', !count && !on && 'opacity-50')}
                title={`${count} open in ${p.name}`}
              >
                <ProjectLabel project={p} active={on} />
                <span className="text-fg-subtle tabular text-[0.6875rem]">{count}</span>
              </button>
            )
          })}
          {noProjectCount > 0 || projectOn('none') ? (
            <button
              type="button"
              onClick={() => setView({ project: projectOn('none') ? '' : 'none', subject: '' })}
              aria-pressed={projectOn('none')}
              className={cn(
                CHIP,
                projectOn('none') ? 'bg-surface-raised text-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-hover',
                view.project && !projectOn('none') && 'opacity-60 hover:opacity-100',
              )}
              title="Todos whose subject belongs to no project, or that have no subject"
            >
              No project
              <span className="text-fg-subtle tabular text-[0.6875rem]">{noProjectCount}</span>
            </button>
          ) : null}
        </div>

        <span className="bg-border mx-1 hidden h-[1rem] w-px shrink-0 sm:block" aria-hidden />

        <Select
          size="sm"
          value={view.subject}
          onChange={(e) => setView({ subject: e.target.value })}
          aria-label="Filter by subject"
          className={cn('max-w-[15rem]', view.subject && 'border-accent/70 text-accent')}
        >
          <option value="">All subjects</option>
          {subjects.map((s) => (
            <option key={s.ref} value={s.ref}>
              {s.ref} · {s.title}
            </option>
          ))}
          <option value="none">No subject</option>
        </Select>

        <span className="ml-auto flex items-center gap-1">
          <span className="text-fg-subtle hidden text-[0.6875rem] sm:inline">Group</span>
          <span className="border-border flex h-[1.625rem] items-center rounded-md border p-0.5" role="group" aria-label="Group by">
            {(Object.keys(GROUP_LABEL) as TodoGroup[]).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setView({ group: g })}
                aria-pressed={view.group === g}
                className={cn(
                  'h-full rounded-[4px] px-1.5 text-[0.6875rem] transition-colors duration-[var(--dur-1)]',
                  view.group === g ? 'bg-surface-raised text-fg' : 'text-fg-subtle hover:text-fg',
                )}
              >
                {GROUP_LABEL[g]}
              </button>
            ))}
          </span>
          <button
            type="button"
            onClick={() => setView({ closed: !view.closed })}
            className="text-fg-subtle hover:text-fg ml-1.5 shrink-0 text-[0.71875rem] whitespace-nowrap transition-colors"
          >
            {view.closed ? 'Hide closed' : `Show ${closedCount} closed`}
          </button>
        </span>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title={filtered ? 'No todos match these filters.' : 'Nothing open. Everything here is closed.'}
          action={
            filtered ? (
              <button type="button" onClick={() => setView({ project: '', subject: '' })} className="text-accent text-[0.75rem] hover:underline">
                Clear filters
              </button>
            ) : !view.closed && closedCount > 0 ? (
              <button type="button" onClick={() => setView({ closed: true })} className="text-accent text-[0.75rem] hover:underline">
                Show {closedCount} closed
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="pb-8">
          {groups.map((group) => (
            <section key={group.key}>
              <GroupHeading group={group} />
              <ul className="divide-border/60 divide-y">
                {group.todos.map((todo) => (
                  <Row key={todo.id} todo={todo} showSubject={view.group !== 'subject'} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

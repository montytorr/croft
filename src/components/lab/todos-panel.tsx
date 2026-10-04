'use client'

import {
  DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useDraggable, useDroppable,
  useSensor, useSensors, type CollisionDetection, type DragEndEvent,
} from '@dnd-kit/core'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import { Columns3, List, Plus, Undo2 } from 'lucide-react'
import { ResolutionDialog } from '@/app/(app)/projects/[key]/resolution-dialog'
import { Avatar, StatusIcon } from '@/components/icons'
import { HandoffBadge } from '@/components/handoff-badge'
import { RelativeTime } from '@/components/relative-time'
import { Spinner } from '@/components/spinner'
import { useMutate } from '@/lib/api/use-mutate'
import { TODO_PROJECT_KEY, type SubjectTodo } from '@/lib/lab/types'
import { TASK_STATUSES, type ResolutionKind, type TaskStatus } from '@/schemas/task'
import { cn } from '@/lib/utils'
import {
  STATUS_LABEL, boardLanes, counts, isHandedOff, laneOf, listGroups, needsResolution, type PageTodo,
} from './todo-lanes'
import { TakeBackDialog } from './take-back-dialog'

export type TodoView = 'list' | 'board'

const todoHref = (todo: PageTodo) => `/projects/${TODO_PROJECT_KEY}/tasks/${todo.number}`

/** Unlinks a handed-off todo from its tracker so it is worked here again; offered where the viewer may. */
const TakeBackButton = ({ todo, onTakeBack }: { todo: PageTodo; onTakeBack?: (todo: PageTodo) => void }) =>
  todo.handoff && onTakeBack ? (
    <button
      type="button"
      onClick={() => onTakeBack(todo)}
      title={`Take ${todo.ref} back from ${todo.handoff.tracker}`}
      className="text-fg-subtle hover:text-fg relative z-10 inline-flex h-[1.125rem] shrink-0 items-center gap-1 rounded px-1 text-[0.625rem] transition-colors"
    >
      <Undo2 size={10} aria-hidden />
      Take back
    </button>
  ) : null

const HeldBy = ({ agent }: { agent: string }) => (
  <span className="text-fg-subtle inline-flex min-w-0 items-center gap-1 text-[0.6875rem]" title={`Claimed by ${agent}`}>
    <span className="bg-status-doing live-dot size-[0.375rem] shrink-0 rounded-full text-status-doing" aria-hidden />
    <span className="text-fg-muted truncate font-mono text-[0.65625rem]">{agent}</span>
  </span>
)

/** A todo's status, changed in place from its icon; a handed-off todo's moves in its tracker, so it is shown and not offered. */
const StatusControl = ({ todo, onChange }: { todo: PageTodo; onChange: (status: TaskStatus) => void }) => {
  const status = laneOf(todo)
  if (todo.handoff) {
    return (
      <span className="grid size-5 shrink-0 place-items-center opacity-60" title={`Moves in ${todo.handoff.tracker}`}>
        <StatusIcon status={status} size={13} />
      </span>
    )
  }
  return (
    <span className="hover:bg-surface-raised relative z-10 grid size-5 shrink-0 place-items-center rounded transition-colors">
      <StatusIcon status={status} size={13} />
      <select
        value={status}
        aria-label={`Status of ${todo.ref}`}
        onChange={(e) => onChange(e.target.value as TaskStatus)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {TASK_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
    </span>
  )
}

const closedTitle = (status: string) =>
  status === 'done' || status === 'cancelled' ? 'text-fg-subtle line-through decoration-fg-subtle/40' : 'text-fg'

const TodoRow = ({
  todo,
  onStatus,
  onTakeBack,
}: {
  todo: PageTodo
  onStatus: (todo: PageTodo, s: TaskStatus) => void
  onTakeBack?: (todo: PageTodo) => void
}) => (
  <li className="group/row row-hover relative flex h-[1.875rem] items-center gap-2 rounded-md px-2">
    <StatusControl todo={todo} onChange={(s) => onStatus(todo, s)} />
    <Link href={todoHref(todo)} className="min-w-0 flex-1 truncate text-[0.8125rem] after:absolute after:inset-0">
      <span className={closedTitle(todo.status)}>{todo.title}</span>
    </Link>
    {todo.claimed_by ? <span className="hidden max-w-[10rem] sm:flex"><HeldBy agent={todo.claimed_by} /></span> : null}
    <HandoffBadge handoff={todo.handoff} className="relative z-10" />
    <TakeBackButton todo={todo} onTakeBack={onTakeBack} />
    {todo.assignee ? (
      <span title={todo.assignee.name} className="hidden shrink-0 sm:block">
        <Avatar name={todo.assignee.name} size={16} />
      </span>
    ) : null}
    <span className="text-fg-subtle w-[3.25rem] shrink-0 text-right font-mono text-[0.65625rem]">{todo.ref}</span>
    <RelativeTime iso={todo.updated_at} className="text-fg-subtle hidden w-[4.5rem] shrink-0 text-right text-[0.6875rem] md:block" />
  </li>
)

const TodoCard = ({ todo, lifted, onTakeBack }: { todo: PageTodo; lifted?: boolean; onTakeBack?: (todo: PageTodo) => void }) => (
  <div
    className={cn(
      'bg-surface border-border group/card relative flex flex-col gap-1.5 rounded-md border px-2.5 py-2',
      'transition-[border-color,background-color] duration-[var(--dur-1)] hover:border-border-strong',
      lifted && 'border-accent/50 rotate-[1.25deg] shadow-lg',
      isHandedOff(todo) && 'bg-bg-elevated/60 border-dashed',
    )}
  >
    <Link href={todoHref(todo)} className="text-[0.8125rem] leading-snug after:absolute after:inset-0" draggable={false}>
      <span className={cn('line-clamp-3', closedTitle(todo.status))}>{todo.title}</span>
    </Link>
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-fg-subtle font-mono text-[0.625rem]">{todo.ref}</span>
      {todo.claimed_by ? <HeldBy agent={todo.claimed_by} /> : null}
      <HandoffBadge handoff={todo.handoff} className="relative z-10" />
      <TakeBackButton todo={todo} onTakeBack={onTakeBack} />
      {todo.assignee ? (
        <span title={todo.assignee.name} className="ml-auto shrink-0">
          <Avatar name={todo.assignee.name} size={16} />
        </span>
      ) : null}
    </div>
  </div>
)

const DraggableCard = ({ todo, onTakeBack }: { todo: PageTodo; onTakeBack?: (todo: PageTodo) => void }) => {
  const pushed = isHandedOff(todo)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: todo.id, disabled: pushed })
  return (
    <div
      ref={setNodeRef}
      {...(pushed ? {} : listeners)}
      {...(pushed ? {} : attributes)}
      className={cn('rounded-md', !pushed && 'cursor-grab', isDragging && 'opacity-40')}
      title={todo.handoff ? `Handed off to ${todo.handoff.tracker}: its status moves there.` : undefined}
    >
      <TodoCard todo={todo} onTakeBack={onTakeBack} />
    </div>
  )
}

const Lane = ({ status, todos, onTakeBack }: { status: TaskStatus; todos: PageTodo[]; onTakeBack?: (todo: PageTodo) => void }) => {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <section
      aria-label={STATUS_LABEL[status]}
      className="bg-bg-elevated flex min-h-[8rem] min-w-[13.5rem] flex-col rounded-lg"
    >
      <header className="flex h-8 shrink-0 items-center gap-1.5 px-2.5">
        <StatusIcon status={status} size={12} />
        <span className="text-fg text-[0.75rem] font-medium">{STATUS_LABEL[status]}</span>
        <span className="count ml-auto">{todos.length}</span>
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          'flex flex-1 flex-col gap-1.5 rounded-b-lg px-1.5 pb-1.5',
          'outline-1 -outline-offset-1 outline-dashed transition-[background-color,outline-color] duration-[var(--dur-2)]',
          isOver ? 'bg-accent-subtle outline-accent/70' : 'outline-transparent',
        )}
      >
        {todos.length === 0 ? (
          <p className={cn('text-fg-subtle grid flex-1 place-items-center py-4 text-[0.6875rem]', isOver && 'text-accent')}>
            {isOver ? 'Drop here' : 'Nothing here'}
          </p>
        ) : (
          todos.map((todo) => <DraggableCard key={todo.id} todo={todo} onTakeBack={onTakeBack} />)
        )}
      </div>
    </section>
  )
}

/** The lane under the pointer; a keyboard drag, with no pointer, falls back to overlap. */
const laneUnderPointer: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length > 0 ? hits : rectIntersection(args)
}

/**
 * A subject's todos, in the page: a list grouped by status, or a board with a
 * lane per status. Each is an ordinary task in the `T` project — claimable by
 * an agent, with its own notes and resolution — so each opens its task page.
 *
 * Dragging a card (or picking from a row's status icon) patches the task;
 * closing one asks for its resolution first, as everywhere else. A todo that
 * was handed off to another tracker is worked there: it shows that tracker's
 * status and link, cannot be dragged here, and can be taken back.
 */
export const TodosPanel = ({
  subjectRef,
  todos: initial,
  initialView = 'list',
  canTakeBack = true,
}: {
  subjectRef: string
  todos: PageTodo[]
  initialView?: TodoView
  /** Whether the viewer may take a hand-off back; the server decides in the end and its refusal is shown. */
  canTakeBack?: boolean
}) => {
  const router = useRouter()
  const request = useMutate()
  const [todos, setTodos] = useState(initial)
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setTodos(initial)
  }
  const [view, setViewState] = useState<TodoView>(initialView)
  const [showCancelled, setShowCancelled] = useState(false)
  const [title, setTitle] = useState('')
  const [adding, setAdding] = useState(false)
  const [dragging, setDragging] = useState<PageTodo | null>(null)
  const [closing, setClosing] = useState<{ todo: PageTodo; status: TaskStatus } | null>(null)
  const [takingBack, setTakingBack] = useState<PageTodo | null>(null)

  const setView = (next: TodoView) => {
    setViewState(next)
    const url = new URL(window.location.href)
    if (next === 'list') url.searchParams.delete('view')
    else url.searchParams.set('view', next)
    window.history.replaceState(window.history.state, '', url)
  }

  // A touch has to rest on a card before it lifts, so a swipe across the
  // lanes on a phone scrolls them instead of dragging the first card it meets.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  )

  const add = async () => {
    if (!title.trim() || adding) return
    setAdding(true)
    const result = await request<SubjectTodo>(`/api/v1/subjects/${subjectRef}/todos`, {
      method: 'POST',
      body: { title: title.trim() },
    })
    setAdding(false)
    if (!result.ok) return
    setTitle('')
    if (result.data?.id) setTodos((current) => [...current, result.data])
    router.refresh()
  }

  const persist = async (
    todo: PageTodo,
    status: TaskStatus,
    close?: { resolution: string; kind: ResolutionKind; duplicateOf?: string },
  ) => {
    const previous = todos
    setTodos((current) => current.map((t) => (t.id === todo.id ? { ...t, status } : t)))
    const result = await request(`/api/v1/tasks/${todo.ref}`, {
      method: 'PATCH',
      body: close
        ? {
            status,
            resolution: close.resolution,
            resolutionKind: close.kind,
            ...(close.duplicateOf ? { duplicateOf: close.duplicateOf } : {}),
          }
        : { status },
    })
    if (!result.ok) {
      setTodos(previous)
      return false
    }
    router.refresh()
    return true
  }

  const cancelTakeBack = useCallback(() => setTakingBack(null), [])

  const takeBack = async (todo: PageTodo) => {
    const result = await request<PageTodo>(`/api/v1/tasks/${todo.ref}/handoff`, { method: 'DELETE' })
    if (!result.ok) return false
    setTodos((current) => current.map((t) => (t.id === todo.id ? { ...t, handoff: null } : t)))
    router.refresh()
    return true
  }

  const changeStatus = (todo: PageTodo, status: TaskStatus) => {
    if (isHandedOff(todo) || laneOf(todo) === status) return
    if (needsResolution(todo.status, status)) {
      setClosing({ todo, status })
      return
    }
    void persist(todo, status)
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null)
    const todo = todos.find((t) => t.id === active.id)
    if (!todo || !over) return
    changeStatus(todo, over.id as TaskStatus)
  }

  const onTakeBack = canTakeBack ? setTakingBack : undefined
  const tally = counts(todos)
  const lanes = boardLanes(todos, showCancelled)

  const segment = (value: TodoView, label: string, Icon: typeof List) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => setView(value)}
      className={cn(
        'flex h-[1.5rem] items-center gap-1.5 rounded-[5px] px-2 text-[0.75rem] transition-colors duration-[var(--dur-1)]',
        view === value ? 'bg-surface text-fg ring-border shadow-[0_1px_0_var(--border)] ring-1' : 'text-fg-muted hover:text-fg',
      )}
    >
      <Icon size={13} aria-hidden />
      {label}
    </button>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="border-border focus-within:border-accent bg-surface flex h-[2rem] min-w-[14rem] flex-1 items-center gap-1.5 rounded-md border pr-1 pl-2.5 transition-[border-color,box-shadow] focus-within:shadow-[0_0_0_1px_var(--accent)] sm:max-w-[32rem]">
          <Plus size={13} aria-hidden className="text-fg-subtle shrink-0" />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void add()
              }
            }}
            maxLength={300}
            placeholder={todos.length ? 'Add a todo…' : 'What is the first concrete thing to do?'}
            aria-label="New todo"
            className="text-fg placeholder:text-fg-subtle h-full min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none"
          />
          {adding ? (
            <span className="text-fg-subtle px-1.5">
              <Spinner size={12} />
            </span>
          ) : title.trim() ? (
            <kbd className="kbd inline-flex">↵</kbd>
          ) : null}
        </div>

        <p className="text-fg-subtle text-[0.75rem] tabular-nums">
          <span className="text-fg-muted">{tally.open}</span> open · {tally.done} done
        </p>

        <div className="ml-auto flex items-center gap-2">
          {tally.cancelled > 0 ? (
            <button
              type="button"
              aria-pressed={showCancelled}
              onClick={() => setShowCancelled((v) => !v)}
              className={cn('h-[1.5rem] rounded-md px-2 text-[0.75rem] transition-colors', showCancelled ? 'text-fg bg-surface-raised' : 'text-fg-subtle hover:text-fg')}
            >
              {showCancelled ? 'Hide' : 'Show'} cancelled <span className="tabular-nums">({tally.cancelled})</span>
            </button>
          ) : null}
          <div className="bg-surface-raised flex items-center gap-0.5 rounded-md p-0.5" role="group" aria-label="View">
            {segment('list', 'List', List)}
            {segment('board', 'Board', Columns3)}
          </div>
        </div>
      </div>

      {view === 'list' ? (
        todos.length === 0 ? (
          <p className="text-fg-subtle border-border rounded-lg border border-dashed px-4 py-8 text-center text-[0.8125rem]">
            No todos yet. A todo is one concrete piece of work an agent or a person can pick up.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {listGroups(todos, showCancelled).map((group) => (
              <section key={group.status} aria-label={STATUS_LABEL[group.status]}>
                <h3 className="border-border mb-0.5 flex h-7 items-center gap-1.5 border-b px-2">
                  <StatusIcon status={group.status} size={12} />
                  <span className="text-fg-muted text-[0.75rem] font-medium">{STATUS_LABEL[group.status]}</span>
                  <span className="count">{group.todos.length}</span>
                </h3>
                <ul className="flex flex-col">
                  {group.todos.map((todo) => (
                    <TodoRow key={todo.id} todo={todo} onStatus={changeStatus} onTakeBack={onTakeBack} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )
      ) : (
        <DndContext
          id={`todos-${subjectRef}`}
          sensors={sensors}
          collisionDetection={laneUnderPointer}
          onDragStart={({ active }) => setDragging(todos.find((t) => t.id === active.id) ?? null)}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          <div className="-mx-4 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(13.5rem, 1fr))` }}
            >
              {lanes.map((status) => (
                <Lane key={status} status={status} todos={todos.filter((t) => laneOf(t) === status)} onTakeBack={onTakeBack} />
              ))}
            </div>
          </div>
          <DragOverlay>{dragging ? <TodoCard todo={dragging} lifted /> : null}</DragOverlay>
        </DndContext>
      )}

      {takingBack?.handoff ? (
        <TakeBackDialog
          todoRef={takingBack.ref}
          handoff={takingBack.handoff}
          onCancel={cancelTakeBack}
          onConfirm={async () => {
            const ok = await takeBack(takingBack)
            if (ok) setTakingBack(null)
            return ok
          }}
        />
      ) : null}

      {closing ? (
        <ResolutionDialog
          taskTitle={closing.todo.title}
          status={closing.status}
          suggestion={null}
          onCancel={() => setClosing(null)}
          onConfirm={async (resolution, kind, duplicateOf) => {
            const ok = await persist(closing.todo, closing.status, { resolution, kind, duplicateOf })
            if (ok) setClosing(null)
            return ok
          }}
        />
      ) : null}
    </div>
  )
}

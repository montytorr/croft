'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowUpRight, Plus } from 'lucide-react'
import { StatusIcon } from '@/components/icons'
import { Spinner } from '@/components/spinner'
import { useMutate } from '@/lib/api/use-mutate'
import { TODO_PROJECT_KEY, type SubjectTodo } from '@/lib/lab/types'
import type { TaskStatus } from '@/schemas/task'
import { cn } from '@/lib/utils'
import { LABEL } from './subject-properties'

const CLOSED = new Set(['done', 'cancelled'])

/**
 * Where a todo's work is being done in Cairn, when it was pushed there:
 * `↗ CAIRN-331 · doing`. The status is as of the last sync, which is why it
 * sits in the subtle grey rather than borrowing a status colour it may no
 * longer have.
 */
const CairnBadge = ({ todo }: { todo: SubjectTodo }) =>
  todo.cairn_ref ? (
    <span
      className="border-border text-fg-muted inline-flex h-[1.125rem] shrink-0 items-center gap-1 rounded border px-1.5 font-mono text-[0.625rem]"
      title={`Pushed to Cairn as ${todo.cairn_ref}${todo.cairn_status ? `; ${todo.cairn_status} at the last sync` : ''}`}
    >
      <ArrowUpRight size={10} aria-hidden />
      {todo.cairn_ref}
      {todo.cairn_status ? <span className="text-fg-subtle">· {todo.cairn_status}</span> : null}
    </span>
  ) : null

/**
 * A subject's todos: the concrete work it needs. Each is an ordinary task in
 * the `T` project — claimable by an agent, with its own notes and resolution
 * — so each row opens the task page. Adding one is a line and Enter.
 */
export const TodosPanel = ({ subjectRef, todos: initial }: { subjectRef: string; todos: SubjectTodo[] }) => {
  const router = useRouter()
  const request = useMutate()
  const [todos, setTodos] = useState(initial)
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setTodos(initial)
  }
  const [title, setTitle] = useState('')
  const [pending, setPending] = useState(false)

  const add = async () => {
    if (!title.trim() || pending) return
    setPending(true)
    const result = await request<SubjectTodo>(`/api/v1/subjects/${subjectRef}/todos`, {
      method: 'POST',
      body: { title: title.trim() },
    })
    setPending(false)
    if (!result.ok) return
    setTitle('')
    if (result.data?.id) setTodos((current) => [...current, result.data])
    router.refresh()
  }

  const open = todos.filter((t) => !CLOSED.has(t.status))
  const closed = todos.filter((t) => CLOSED.has(t.status))

  const row = (todo: SubjectTodo) => (
    <li key={todo.id}>
      <Link
        href={`/projects/${TODO_PROJECT_KEY}/tasks/${todo.number}`}
        className="row-hover -mx-2 flex min-h-[2.25rem] items-center gap-2 rounded-md px-2 py-1"
      >
        <StatusIcon status={todo.status as TaskStatus} size={13} />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[0.8125rem]', CLOSED.has(todo.status) ? 'text-fg-subtle line-through decoration-fg-subtle/40' : 'text-fg')}>
            {todo.title}
          </span>
          {todo.claimed_by || todo.cairn_ref ? (
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {todo.claimed_by ? (
                <span className="text-fg-subtle truncate text-[0.6875rem]" title={`Held by ${todo.claimed_by}`}>
                  held by <span className="text-fg-muted">{todo.claimed_by}</span>
                </span>
              ) : null}
              <CairnBadge todo={todo} />
            </span>
          ) : null}
        </span>
        <span className="text-fg-subtle shrink-0 font-mono text-[0.625rem]">{todo.ref}</span>
      </Link>
    </li>
  )

  return (
    <section aria-labelledby="todos-heading">
      <h2 id="todos-heading" className={cn(LABEL, 'mb-2 flex items-center gap-2')}>
        Todos
        <span className="bg-surface-raised text-fg-muted rounded-full px-1.5 py-px text-[0.625rem] tracking-normal tabular-nums">
          {open.length} open · {closed.length} done
        </span>
      </h2>

      {todos.length > 0 ? (
        <ul className="mb-2 flex flex-col">
          {open.map(row)}
          {closed.map(row)}
        </ul>
      ) : (
        <p className="text-fg-subtle mb-2 text-[0.75rem]">No todos yet. What is the first concrete thing to do?</p>
      )}

      <div className="border-border focus-within:border-accent bg-surface flex items-center gap-1.5 rounded-lg border pr-1 pl-2.5 transition-[border-color,box-shadow] focus-within:shadow-[0_0_0_1px_var(--accent)]">
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
          placeholder="Add a todo…"
          aria-label="New todo"
          className="text-fg placeholder:text-fg-subtle h-[2.125rem] min-w-0 flex-1 bg-transparent text-[0.8125rem] outline-none"
        />
        {pending ? (
          <span className="text-fg-subtle px-1.5"><Spinner size={12} /></span>
        ) : title.trim() ? (
          <kbd className="kbd inline-flex">↵</kbd>
        ) : null}
      </div>
    </section>
  )
}

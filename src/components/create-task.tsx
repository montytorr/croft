'use client'

import { Spinner } from '@/components/spinner'

import { Button } from '@/components/ui/control'

import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/api/mutate'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Avatar, PriorityIcon, StatusIcon, TypePill } from '@/components/icons'
import { usePeople } from '@/components/people-context'
import {
  TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES,
  type TaskPriority, type TaskStatus, type TaskType,
} from '@/schemas/task'
import { TODO_PROJECT_KEY, type SubjectSummary } from '@/lib/lab/types'
import type { TodoContext } from '@/lib/lab/ui-shortcuts'
import { cn } from '@/lib/utils'

type SubjectChoice = Pick<SubjectSummary, 'number' | 'ref' | 'title'>

/**
 * New todo.
 *
 * A todo is always for a subject, so the dialog asks which: a picker of the
 * subjects you can see, set to the one you are looking at when there is one.
 * From a todo's own page it can instead file a sub-task of that todo, which
 * stays with the parent's subject and so needs no picker. Everything except
 * the title has a default: press c, type, press enter.
 */
export const CreateTask = ({
  context,
  open,
  onClose,
}: {
  context: TodoContext
  open: boolean
  onClose: () => void
}) => {
  const router = useRouter()
  const titleRef = useRef<HTMLInputElement>(null)
  const { people, currentUserId } = usePeople()

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [subjects, setSubjects] = useState<SubjectChoice[] | null>(null)
  const [subject, setSubject] = useState(context.subject === null ? '' : String(context.subject))
  const [subTask, setSubTask] = useState(false)
  const [type, setType] = useState<TaskType>('chore')
  const [status, setStatus] = useState<TaskStatus>('todo')
  const [priority, setPriority] = useState<TaskPriority>('medium')
  const [assignee, setAssignee] = useState(currentUserId)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [similar, setSimilar] = useState<{ ref: string; title: string; status: string }[]>([])

  const { parentRef } = context
  const contextSubject = context.subject
  const filingSubTask = subTask && parentRef !== null

  // The subjects you can see, once per open: the dialog remounts on each open,
  // and keeping the list out of the layout keeps every page from carrying it.
  // From a todo's page the default is that todo's subject.
  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      try {
        const [list, parent] = await Promise.all([
          fetch('/api/v1/subjects', { signal: controller.signal }),
          parentRef && contextSubject === null
            ? fetch(`/api/v1/tasks/${parentRef}`, { signal: controller.signal })
            : Promise.resolve(null),
        ])
        const listed = list.ok ? await list.json().catch(() => null) : null
        // A failed read is not an empty lab: say so rather than "No subjects yet".
        if (!list.ok) setError(`Could not load the subjects (${list.status}). Close and try again.`)
        setSubjects(((listed?.data ?? []) as SubjectChoice[]).map(({ number, ref, title: name }) => ({ number, ref, title: name })))
        const parentJson = parent?.ok ? await parent.json().catch(() => null) : null
        const parentSubject = parentJson?.data?.subject?.number
        if (typeof parentSubject === 'number') setSubject((current) => current || String(parentSubject))
      } catch {
        // aborted, or offline: the picker stays empty and says so
        setSubjects((current) => current ?? [])
      }
    }
    void load()
    return () => controller.abort()
  }, [parentRef, contextSubject])

  // Focus only. State is NOT reset here: the parent remounts this component
  // on each open (via key), so it always starts fresh without an effect
  // writing state synchronously.
  useEffect(() => {
    if (open) titleRef.current?.focus()
  }, [open])

  // The same duplicate check the CLI does on `croft add`, surfaced as you
  // type. Finding the existing todo is more useful than filing a second one.
  // Derived rather than cleared in an effect.
  const showSimilar = title.trim().length >= 8
  const visibleSimilar = showSimilar ? similar : []

  useEffect(() => {
    if (!open || !showSimilar) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/v1/search?q=${encodeURIComponent(title)}&kinds=task&limit=3`, {
          signal: controller.signal,
        })
        const payload = await res.json()
        setSimilar(payload.success ? payload.data.results : [])
      } catch {
        // aborted; keep what is on screen
      }
    }, 400)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [title, open, showSimilar])

  const chosen = subjects?.find((s) => String(s.number) === subject)
  const ready = Boolean(title.trim()) && (filingSubTask || Boolean(chosen))

  const submit = useCallback(async () => {
    if (!ready || pending) return
    setPending(true)
    setError(null)

    const fields = {
      title: title.trim(),
      description: body.trim() || undefined,
      type,
      status,
      priority,
      assignee,
    }
    const result = await mutate<{ number: number }>(
      filingSubTask
        ? `/api/v1/projects/${TODO_PROJECT_KEY}/tasks`
        : `/api/v1/subjects/${chosen?.ref}/todos`,
      { method: 'POST', body: filingSubTask ? { ...fields, parentRef } : fields },
    )
    setPending(false)

    if (!result.ok) {
      setError(result.error)
      return
    }
    onClose()
    router.push(`/projects/${TODO_PROJECT_KEY}/tasks/${result.data.number}`)
    router.refresh()
  }, [ready, pending, title, body, type, status, priority, assignee, filingSubTask, chosen?.ref, parentRef, onClose, router])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void submit()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, submit])

  if (!open) return null

  // The select inside each chip is invisible, so the chip shows its focus.
  const chip =
    'relative flex h-[1.625rem] items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[0.75rem] ' +
    'text-fg-muted transition-[color,background-color,border-color,box-shadow] duration-[var(--dur-1)] ease-[var(--ease-out)] ' +
    'hover:border-border-strong hover:bg-surface-hover hover:text-fg ' +
    'focus-within:border-accent focus-within:text-fg focus-within:ring-2 focus-within:ring-ring/50'

  const noSubjects = subjects !== null && subjects.length === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div className="scrim absolute inset-0" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New todo"
        className="border-border bg-surface raised-lg enter-sheet relative w-full max-w-[35rem] overflow-hidden rounded-xl border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-border flex items-center gap-2 border-b px-4 py-2.5">
          <span className="text-fg-subtle text-[0.6875rem]">
            {filingSubTask ? `New sub-task of ${parentRef}` : 'New todo'}
          </span>
        </div>

        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Todo title"
          aria-label="Title"
          className="placeholder:text-fg-subtle text-fg w-full bg-transparent px-4 pt-3 pb-1 text-[1rem] outline-none"
        />

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Description — markdown, optional"
          rows={3}
          className="placeholder:text-fg-subtle w-full resize-none bg-transparent px-4 pb-3 text-[0.8125rem] leading-relaxed outline-none"
        />

        {visibleSimilar.length > 0 && (
          <div className="border-border bg-surface-raised/50 enter-rise mx-4 mb-3 rounded-md border px-2.5 py-2">
            <p className="text-fg-subtle mb-1.5 text-[0.6875rem]">Similar work already exists</p>
            <ul className="flex flex-col gap-1">
              {visibleSimilar.map((s) => (
                <li key={s.ref} className="flex items-center gap-2 text-[0.75rem]">
                  <StatusIcon status={s.status as TaskStatus} size={12} />
                  <code className="text-fg-subtle text-[0.6875rem]">{s.ref}</code>
                  <span className="text-fg-muted min-w-0 truncate">{s.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-border bg-surface-raised/40 flex flex-wrap items-center gap-1.5 border-t px-4 py-2.5">
          {filingSubTask ? null : (
            <label className={cn(chip, 'max-w-full min-w-0')}>
              <span className="text-fg-subtle font-mono text-[0.6875rem]">{chosen?.ref ?? 'S-?'}</span>
              <span className="max-w-[16rem] min-w-0 truncate">
                {chosen?.title ?? (subjects === null ? 'Loading subjects…' : noSubjects ? 'No subjects yet' : 'Pick a subject')}
              </span>
              <select
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={noSubjects}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Subject"
              >
                {chosen ? null : <option value="">Pick a subject</option>}
                {(subjects ?? []).map((s) => (
                  <option key={s.number} value={s.number}>
                    {s.ref} {s.title}
                  </option>
                ))}
              </select>
            </label>
          )}

          {parentRef ? (
            <button
              type="button"
              aria-pressed={subTask}
              onClick={() => setSubTask((on) => !on)}
              className={cn(chip, 'font-mono', subTask && 'border-accent text-fg')}
              title="File it under this todo instead of straight under its subject"
            >
              Sub-task of {parentRef}
            </button>
          ) : null}

          <label className={cn(chip, 'pr-1')}>
            <TypePill type={type} />
            <select
              value={type}
              onChange={(e) => setType(e.target.value as TaskType)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Type"
            >
              {TASK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>

          <label className={chip}>
            <StatusIcon status={status} size={13} />
            {status}
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as TaskStatus)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Status"
            >
              {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <label className={chip}>
            <PriorityIcon priority={priority} size={13} />
            {priority}
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Priority"
            >
              {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>

          <label className={chip}>
            <Avatar name={people.find((p) => p.id === assignee)?.name ?? 'You'} size={14} />
            {people.find((p) => p.id === assignee)?.name ?? 'You'}
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Assignee"
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={!ready || pending}
            className="ml-auto h-[1.625rem] px-3 text-[0.75rem]"
          >
            {pending ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner />
                Creating…
              </span>
            ) : (
              'Create'
            )}
          </Button>
        </div>

        {error && (
          <p className="text-danger bg-danger-subtle/60 border-border enter-rise border-t px-4 py-2 text-[0.75rem]" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import { StatusIcon } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import { outlineOf } from '@/lib/editor/outline'
import { TODO_PROJECT_KEY, type SubjectHumanNote } from '@/lib/lab/types'
import { cn } from '@/lib/utils'
import { useOpenTab } from './subject-workspace'
import { laneOf, type PageTodo } from './todo-lanes'

const OPEN_ORDER = ['doing', 'in-review', 'todo', 'backlog'] as const

const Heading = ({ children, onMore, more }: { children: React.ReactNode; onMore?: () => void; more?: string }) => (
  <div className="mb-3 flex min-h-6 items-center gap-2">
    <h3 className="pane-label">{children}</h3>
    {onMore ? (
      <button type="button" onClick={onMore} className="text-fg-subtle hover:text-fg ml-auto flex h-6 items-center gap-1 text-aux transition-colors">
        {more}
        <ArrowRight size={11} aria-hidden />
      </button>
    ) : null}
  </div>
)

/** A preview of a note: its first line or so, markdown stripped to the words. */
const gist = (body: string) =>
  body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * What sits beside the write-up on a wide screen, so the page around a
 * comfortable reading measure is not empty paper: the write-up's outline,
 * the work still open, and the latest notes — each a way into its section.
 */
export const WriteUpAside = ({
  body,
  todos,
  notes,
}: {
  body: string | null
  todos: PageTodo[]
  notes: SubjectHumanNote[]
}) => {
  const openTab = useOpenTab()
  const outline = useMemo(() => outlineOf(body ?? ''), [body])
  const open = useMemo(
    () =>
      todos
        .filter((t) => (OPEN_ORDER as readonly string[]).includes(laneOf(t)))
        .sort((a, b) => OPEN_ORDER.indexOf(laneOf(a) as never) - OPEN_ORDER.indexOf(laneOf(b) as never)),
    [todos],
  )

  const jump = (index: number) => {
    const heading = document.querySelectorAll('#writeup-body :is(h1, h2, h3)')[index]
    heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex flex-col gap-4">
      {outline.length >= 2 ? (
        <nav aria-label="Outline" className="subject-paper p-4">
          <Heading>Outline</Heading>
          <ol className="border-border flex flex-col border-l">
            {outline.map((entry, i) => (
              <li key={`${i}-${entry.text}`}>
                <button
                  type="button"
                  onClick={() => jump(i)}
                  className={cn(
                    'text-fg-muted hover:text-fg hover:border-fg-subtle -ml-px block w-full truncate border-l border-transparent py-[0.1875rem] text-left text-aux transition-colors',
                    entry.level === 1 ? 'pl-3 font-medium' : entry.level === 2 ? 'pl-3' : 'pl-6 text-aux',
                  )}
                >
                  {entry.text}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <section aria-label="Open todos" className="subject-paper p-4">
        <Heading onMore={() => openTab('todos')} more={todos.length ? `All ${todos.length}` : 'Add one'}>
          Open todos
        </Heading>
        {open.length === 0 ? (
          <p className="text-fg-subtle text-aux">{todos.length ? 'Everything is settled.' : 'None yet.'}</p>
        ) : (
          <ul className="flex flex-col">
            {open.slice(0, 6).map((todo) => (
              <li key={todo.id}>
                <Link
                  href={`/projects/${TODO_PROJECT_KEY}/tasks/${todo.number}`}
                  className="row-hover -mx-1.5 flex min-h-8 items-center gap-2 rounded-md px-1.5 py-1"
                >
                  <StatusIcon status={laneOf(todo)} size={12} />
                  <span className="text-fg min-w-0 flex-1 line-clamp-2 text-aux leading-snug">{todo.title}</span>
                  {todo.handoff ? <span className="text-fg-subtle font-mono text-aux">{todo.handoff.ref}</span> : null}
                </Link>
              </li>
            ))}
            {open.length > 6 ? (
              <li className="text-fg-subtle pt-1 text-aux">and {open.length - 6} more</li>
            ) : null}
          </ul>
        )}
      </section>

      <section aria-label="Latest notes" className="subject-paper p-4">
        <Heading onMore={() => openTab('notes')} more={notes.length ? `All ${notes.length}` : 'Write one'}>
          Notes
        </Heading>
        {notes.length === 0 ? (
          <p className="text-fg-subtle text-aux">No notes from anyone yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {notes.slice(0, 3).map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  onClick={() => openTab('notes')}
                  className="bg-surface border-border hover:border-border-strong block w-full rounded-md border px-2.5 py-1.5 text-left transition-colors"
                >
                  <span className="text-fg-subtle flex items-center gap-1.5 text-aux">
                    <span className="text-fg-muted truncate">{note.author.name}</span>
                    <RelativeTime iso={note.created_at} className="ml-auto shrink-0" />
                  </span>
                  <span className="text-fg mt-0.5 line-clamp-2 font-serif text-ui leading-snug">{gist(note.body)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

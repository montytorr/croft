'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { PenLine, Trash2 } from 'lucide-react'
import { Avatar } from '@/components/icons'
import { MarkdownView } from '@/components/markdown'
import { usePeople } from '@/components/people-context'
import { RelativeTime } from '@/components/relative-time'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { useMutate } from '@/lib/api/use-mutate'
import type { SubjectHumanNote } from '@/lib/lab/types'
import { cn } from '@/lib/utils'

const FIELD =
  'writeup-sm text-fg placeholder:text-fg-subtle block w-full resize-y bg-transparent px-3 py-2.5 outline-none [field-sizing:content]'

const Composer = ({
  initial = '',
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  initial?: string
  placeholder?: string
  submitLabel: string
  autoFocus?: boolean
  onSubmit: (body: string) => Promise<boolean>
  onCancel?: () => void
}) => {
  const [text, setText] = useState(initial)
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (!text.trim() || pending) return
    setPending(true)
    const ok = await onSubmit(text.trim())
    setPending(false)
    if (ok && !onCancel) setText('')
  }

  return (
    <div className="bg-surface border-border focus-within:border-accent overflow-hidden rounded-lg border transition-[border-color,box-shadow] duration-[var(--dur-2)] focus-within:shadow-[0_0_0_1px_var(--accent)]">
      <textarea
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape' && onCancel) onCancel()
        }}
        placeholder={placeholder}
        aria-label={submitLabel}
        className={cn(FIELD, 'max-h-[50vh] min-h-[4.5rem]')}
      />
      <div className="border-border/70 flex items-center gap-2 border-t px-2 py-1">
        <span className="text-fg-subtle text-aux">Markdown · ⌘↵</span>
        <span className="ml-auto" />
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel} className="px-2.5 font-normal">
            Cancel
          </Button>
        ) : null}
        <Button size="sm" variant="primary" onClick={() => void submit()} disabled={!text.trim() || pending} className="px-3">
          {pending ? <Spinner /> : submitLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * People's notes on a subject: what someone thinks, asks or wants remembered,
 * in their own words. Not the write-up (one shared account) and not the log
 * (append-only, what was found and tried, mostly by agents): a note has an
 * author, can be edited and removed by them, and reads as a card signed by a
 * person rather than an entry on a timeline.
 */
export const HumanNotesPanel = ({
  subjectRef,
  notes: initial,
  isAdmin = false,
}: {
  subjectRef: string
  notes: SubjectHumanNote[]
  /** An administrator may remove anyone's note (never edit it). */
  isAdmin?: boolean
}) => {
  const router = useRouter()
  const request = useMutate()
  const { currentUserId } = usePeople()
  const [notes, setNotes] = useState(initial)
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setNotes(initial)
  }
  const [editing, setEditing] = useState<string | null>(null)

  const base = `/api/v1/subjects/${subjectRef}/human-notes`

  const add = async (body: string) => {
    const result = await request<SubjectHumanNote>(base, { method: 'POST', body: { body } })
    if (!result.ok) return false
    if (result.data?.id) setNotes((current) => [result.data, ...current.filter((n) => n.id !== result.data.id)])
    router.refresh()
    return true
  }

  const save = async (note: SubjectHumanNote, body: string) => {
    if (body === note.body) {
      setEditing(null)
      return true
    }
    const result = await request<SubjectHumanNote>(`${base}/${note.id}`, { method: 'PATCH', body: { body } })
    if (!result.ok) return false
    setNotes((current) =>
      current.map((n) => (n.id === note.id ? { ...n, ...(result.data?.id ? result.data : { body, updated_at: new Date().toISOString() }) } : n)),
    )
    setEditing(null)
    router.refresh()
    return true
  }

  const remove = async (note: SubjectHumanNote) => {
    if (!window.confirm('Delete this note? It cannot be brought back.')) return
    const result = await request(`${base}/${note.id}`, { method: 'DELETE' })
    if (!result.ok) return
    setNotes((current) => current.filter((n) => n.id !== note.id))
    router.refresh()
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:items-start">
      <div className="flex flex-col gap-2 xl:sticky xl:top-[3.5rem]">
        <Composer
          placeholder="A thought, a question, something to remember about this subject."
          submitLabel="Add note"
          onSubmit={add}
        />
        <p className="text-fg-subtle px-0.5 text-aux leading-relaxed">
          Notes are yours: edit or delete them any time. What was found or tried belongs in the log; the account of the
          subject, in the write-up.
        </p>
      </div>

      {notes.length === 0 ? (
        <p className="text-fg-subtle border-border rounded-lg border border-dashed px-4 py-8 text-center text-ui">
          No notes yet.
        </p>
      ) : (
        <ol className="stagger grid gap-2.5 2xl:grid-cols-2 2xl:items-start">
          {notes.map((note) => {
            const mine = note.author.id === currentUserId
            const edited = note.updated_at && note.updated_at !== note.created_at
            return (
              <li key={note.id} className="bg-surface border-border group/note relative rounded-lg border">
                <header className="flex h-10 items-center gap-2 px-3 pt-1">
                  <Avatar name={note.author.name} size={16} />
                  <span className="text-fg truncate text-aux font-medium">
                    {note.author.name}
                    {mine ? <span className="text-fg-subtle font-normal"> (you)</span> : null}
                  </span>
                  <RelativeTime iso={note.created_at} className="text-fg-subtle shrink-0 text-aux" />
                  {edited ? (
                    <span className="text-fg-subtle hidden text-aux sm:inline">
                      · edited <RelativeTime iso={note.updated_at} />
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-0.5 opacity-0 pointer-coarse:opacity-100 transition-opacity group-hover/note:opacity-100 group-focus-within/note:opacity-100">
                    {mine && editing !== note.id ? (
                      <button
                        type="button"
                        onClick={() => setEditing(note.id)}
                        aria-label="Edit note"
                        className="text-fg-subtle hover:text-fg hover:bg-surface-hover grid size-6 place-items-center rounded transition-colors"
                      >
                        <PenLine size={12} aria-hidden />
                      </button>
                    ) : null}
                    {mine || isAdmin ? (
                      <button
                        type="button"
                        onClick={() => void remove(note)}
                        aria-label="Delete note"
                        className="text-fg-subtle hover:text-danger hover:bg-danger-subtle grid size-6 place-items-center rounded transition-colors"
                      >
                        <Trash2 size={12} aria-hidden />
                      </button>
                    ) : null}
                  </span>
                </header>
                {editing === note.id ? (
                  <div className="p-2 pt-1">
                    <Composer
                      initial={note.body}
                      submitLabel="Save"
                      autoFocus
                      onSubmit={(body) => save(note, body)}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                ) : (
                  <div className="px-3 pt-0.5 pb-3">
                    <MarkdownView prose="writeup-sm">{note.body}</MarkdownView>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

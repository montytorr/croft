'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Globe, Lock } from 'lucide-react'
import { MarkdownView } from '@/components/markdown'
import { RelativeTime } from '@/components/relative-time'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { useMutate } from '@/lib/api/use-mutate'
import { SUBJECT_NOTE_KINDS, type SubjectNote, type SubjectNoteKind } from '@/lib/lab/types'
import { RIG_PATHS } from '@/lib/brand-mark'
import { cn } from '@/lib/utils'
import { LABEL } from './subject-properties'

/** A kind's colour: the --log-* tokens, shared with a todo's work log. */
const tone = (kind: string) => `var(--log-${kind}, var(--fg-subtle))`

/** Written by the server, never typed: a stage move, a publish or a share. */
const SERVER_KINDS: readonly string[] = ['stage', 'visibility']
const serverWritten = (kind: string) => SERVER_KINDS.includes(kind)

/** Kinds a person can write. */
const WRITABLE = SUBJECT_NOTE_KINDS.filter((k) => !serverWritten(k))

const KIND_HINT: Record<string, string> = {
  note: 'What happened, what you noticed.',
  finding: 'Something now known to be true.',
  decision: 'What was decided, and why.',
  attempt: 'What was tried — including what did not work.',
  handoff: 'Where you left it, for whoever picks it up.',
}

/**
 * An entry's dot. A stage move is drawn as a small rig instead: the subject
 * moved along the field. A change of who sees it is a small lock, or a globe
 * once it is published.
 */
const Marker = ({ kind, note }: { kind: string; note: string }) =>
  kind === 'visibility' ? (
    <span
      className="bg-bg relative z-10 mt-[0.25rem] grid size-[0.75rem] shrink-0 place-items-center"
      style={{ color: tone('visibility') }}
    >
      {/^published\b/i.test(note) ? <Globe size={11} aria-hidden /> : <Lock size={11} aria-hidden />}
    </span>
  ) : kind === 'stage' ? (
    <svg viewBox="3 4 25 24" className="relative z-10 mt-[0.3rem] size-[0.75rem] shrink-0" aria-hidden>
      {RIG_PATHS.map((d) => (
        <path key={d} d={d} fill={tone('stage')} />
      ))}
    </svg>
  ) : (
    <span
      className="relative z-10 mt-[0.45rem] ml-[0.125rem] block size-[0.5rem] shrink-0 rounded-full"
      style={{ backgroundColor: tone(kind), boxShadow: '0 0 0 3px var(--bg)' }}
    />
  )

/**
 * The log: append-only, newest first, one entry per thing that happened —
 * notes, findings, decisions, attempts, handoffs, and every stage move. It is
 * the subject's history, not its summary (that is the write-up), so entries
 * are never edited; a correction is a new entry.
 */
export const LogPanel = ({ subjectRef, notes: initial }: { subjectRef: string; notes: SubjectNote[] }) => {
  const router = useRouter()
  const request = useMutate()
  const [notes, setNotes] = useState(initial)
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setNotes(initial)
  }
  const [text, setText] = useState('')
  const [kind, setKind] = useState<SubjectNoteKind>('note')
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (!text.trim() || pending) return
    setPending(true)
    const result = await request<SubjectNote & { duplicate?: boolean }>(`/api/v1/subjects/${subjectRef}/notes`, {
      method: 'POST',
      body: { note: text.trim(), kind },
    })
    setPending(false)
    if (!result.ok) return
    setText('')
    if (result.data?.duplicate) return
    if (result.data?.id) setNotes((current) => [result.data, ...current])
    else router.refresh()
  }

  return (
    <section aria-labelledby="log-heading">
      <h2 id="log-heading" className={cn(LABEL, 'mb-3 flex items-center gap-2')}>
        Log
        <span className="bg-surface-raised text-fg-muted rounded-full px-1.5 py-px text-aux tracking-normal tabular-nums">
          {notes.length}
        </span>
      </h2>

      <div className="control-shell mb-6 overflow-hidden">
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
          placeholder={KIND_HINT[kind] ?? 'Add to the log.'}
          aria-label="Log entry"
          className="control-bare block max-h-[40vh] min-h-[4rem] w-full resize-y px-3.5 py-3 leading-relaxed"
        />
        <div className="border-border/70 flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
          <div role="radiogroup" aria-label="Kind" className="flex flex-wrap items-center gap-0.5">
            {WRITABLE.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  'flex h-[1.5rem] items-center gap-1.5 rounded-md px-2 text-aux transition-colors duration-[var(--dur-1)]',
                  kind === k ? 'bg-surface-raised text-fg' : 'text-fg-subtle hover:text-fg',
                )}
              >
                <span className="size-[0.4375rem] rounded-full" style={{ backgroundColor: tone(k) }} />
                {k}
              </button>
            ))}
          </div>
          <span className="text-fg-subtle ml-auto hidden text-aux sm:block">⌘↵</span>
          <Button size="sm" variant="primary" onClick={() => void submit()} disabled={!text.trim() || pending}>
            {pending ? <Spinner /> : 'Add to log'}
          </Button>
        </div>
      </div>

      {notes.length === 0 ? (
        <p className="text-fg-subtle text-aux">Nothing logged yet. Dead ends are worth recording too.</p>
      ) : (
        <ol className="stagger flex flex-col">
          {notes.map((note) => (
            <li key={note.id} className="group/entry relative flex gap-3 pb-5 last:pb-0">
              <Marker kind={note.kind} note={note.note} />
              <span
                aria-hidden
                className="bg-border absolute top-[1.25rem] bottom-0 left-[0.3125rem] w-px group-last/entry:hidden"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-aux">
                  <span className="font-medium" style={{ color: tone(note.kind) }}>
                    {note.kind}
                  </span>
                  <span className={note.actor_type === 'agent' ? 'text-fg-muted font-mono text-aux' : 'text-fg-muted'}>
                    {note.actor_id}
                  </span>
                  <RelativeTime iso={note.created_at} className="text-fg-subtle ml-auto shrink-0" />
                </div>
                {serverWritten(note.kind) ? (
                  <p className="text-fg-muted mt-0.5 text-ui">{note.note}</p>
                ) : (
                  <div className="mt-1">
                    <MarkdownView prose="writeup-sm">{note.note}</MarkdownView>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

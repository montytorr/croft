'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useRef, useState } from 'react'
import { Check, Globe, Lock, UserPlus, Users, X } from 'lucide-react'
import { Avatar } from '@/components/icons'
import { usePeople } from '@/components/people-context'
import { Button } from '@/components/ui/control'
import { useMutate } from '@/lib/api/use-mutate'
import type { Subject, SubjectVisibility } from '@/lib/lab/types'
import { cn } from '@/lib/utils'
import { PublishDialog } from './publish-dialog'
import { VISIBILITY_HINT, VISIBILITY_LABEL } from './visibility'

const LABEL = 'pane-label'

const RowLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="text-fg-subtle w-[4rem] shrink-0 text-aux">{children}</span>
)

const ICON: Record<SubjectVisibility, typeof Lock> = { private: Lock, members: Users, lab: Globe }

/**
 * Who may manage a subject's audience: its owner, and nobody else. There is
 * no administrator stand-in: a subject whose owner is gone keeps the audience
 * it had until the owner is restored (the database refuses the change too).
 */
export const canManageAccess = (owner: Subject['owner'], { currentUserId }: { currentUserId: string }) =>
  owner !== null && owner.id === currentUserId

/** The two audiences an owner switches between; the lab is its own step. */
const SWITCHABLE = ['private', 'members'] as const satisfies readonly SubjectVisibility[]

/**
 * Private | Members, as a visible switch. It used to be a transparent select
 * laid over the label, which nobody could tell was a control.
 */
const VisibilitySwitch = ({
  value,
  disabled,
  onChange,
}: {
  value: (typeof SWITCHABLE)[number]
  disabled: boolean
  onChange: (next: SubjectVisibility) => void
}) => {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  // Arrow keys move and choose, like any radio group.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    const next = SWITCHABLE[(SWITCHABLE.indexOf(value) + step + SWITCHABLE.length) % SWITCHABLE.length] ?? value
    refs.current[next]?.focus()
    onChange(next)
  }

  return (
    <div
      role="radiogroup"
      aria-label="Visibility"
      onKeyDown={onKeyDown}
      className="border-border bg-surface-raised/40 grid min-w-0 flex-1 grid-cols-2 gap-0.5 rounded-md border p-0.5"
    >
      {SWITCHABLE.map((option) => {
        const Icon = ICON[option]
        const on = option === value
        return (
          <button
            key={option}
            ref={(node) => {
              refs.current[option] = node
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            title={VISIBILITY_HINT[option]}
            onClick={() => onChange(option)}
            className={cn(
              'flex h-[1.5rem] min-w-0 items-center justify-center gap-1 rounded-[5px] px-1.5 text-aux font-medium',
              'transition-[background-color,color,box-shadow] duration-[var(--dur-1)]',
              'focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-2',
              'disabled:cursor-not-allowed disabled:opacity-60',
              on
                ? 'bg-surface text-fg shadow-[0_0_0_1px_var(--border-strong)]'
                : 'text-fg-subtle hover:text-fg',
            )}
          >
            <Icon size={12} aria-hidden className={on ? 'text-fg-muted' : undefined} />
            {VISIBILITY_LABEL[option]}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Who sees the subject, and the way out to the lab. Private and Members
 * switch freely; publishing is a separate, confirmed step because it is the
 * one change that cannot be taken back. Only the owner gets the controls;
 * everyone else who can see the subject reads the same facts without them.
 *
 * `isAdmin` is accepted and ignored: being an administrator grants nothing
 * here.
 */
export const SubjectAccess = ({ subject }: { subject: Subject; isAdmin?: boolean }) => {
  const router = useRouter()
  const request = useMutate()
  const { people, currentUserId } = usePeople()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [publishing, setPublishing] = useState(false)

  const { visibility, members } = subject
  const memberIds = new Set(members.map((m) => m.id))
  const manage = canManageAccess(subject.owner, { currentUserId })
  const Icon = ICON[visibility]

  const send = async (url: string, init: Parameters<typeof request>[1]) => {
    setBusy(true)
    const result = await request(url, init)
    setBusy(false)
    if (result.ok) router.refresh()
    return result.ok
  }

  const base = `/api/v1/subjects/${subject.ref}`
  const setVisibility = (next: SubjectVisibility) =>
    next !== visibility && void send(base, { method: 'PATCH', body: { visibility: next } })
  const add = (userId: string) => void send(`${base}/members`, { method: 'POST', body: { user: userId } })
  const remove = (userId: string) => void send(`${base}/members/${userId}`, { method: 'DELETE' })

  const closePublish = useCallback(() => setPublishing(false), [])
  const publish = useCallback(async () => {
    const result = await request(`/api/v1/subjects/${subject.ref}/publish`, { method: 'POST' })
    if (!result.ok) return false
    setPublishing(false)
    router.refresh()
    return true
  }, [request, router, subject.ref])

  const q = query.trim().toLowerCase()
  const candidates = people.filter(
    (p) => p.id !== subject.owner?.id && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)),
  )
  const ownerIsMe = subject.owner?.id === currentUserId

  return (
    <section className="flex flex-col gap-px" aria-labelledby="access-heading">
      <h2 id="access-heading" className={cn(LABEL, 'mb-2')}>
        Access
      </h2>

      <div className="-mx-2 flex min-h-9 items-center gap-2 px-2">
        <RowLabel>Visibility</RowLabel>
        {manage && visibility !== 'lab' ? (
          // The lab is not an option here: publishing is its own confirmed step below.
          <VisibilitySwitch value={visibility} disabled={busy} onChange={setVisibility} />
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5" title={VISIBILITY_HINT[visibility]}>
            <Icon size={13} aria-hidden className="text-fg-muted shrink-0" />
            <span className="text-fg truncate text-ui">{VISIBILITY_LABEL[visibility]}</span>
          </span>
        )}
      </div>

      {visibility === 'private' ? (
        <p className="text-fg-subtle py-1 text-aux leading-relaxed">
          {ownerIsMe ? 'Only you see it' : `Only ${subject.owner?.name ?? 'its owner'} sees it`}, its todos and its log.
          {manage ? ' Switch to Members to share it with a few people.' : ''}
        </p>
      ) : null}

      {visibility === 'members' ? (
        <div className="-mx-2 flex items-start gap-2 px-2 py-1.5">
          <RowLabel>Members</RowLabel>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {members.length === 0 ? (
              <span className="text-fg-subtle text-aux">Nobody yet besides the owner</span>
            ) : (
              <ul className="flex flex-col gap-0.5" aria-label="Members">
                {members.map((m) => (
                  <li key={m.id} className="group/member flex min-h-[1.5rem] items-center gap-1.5">
                    <Avatar name={m.name} size={16} />
                    <span className="text-fg min-w-0 flex-1 truncate text-ui">
                      {m.name}
                      {m.id === currentUserId ? <span className="text-fg-subtle"> (you)</span> : null}
                    </span>
                    {manage ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(m.id)}
                        aria-label={`Remove ${m.name}`}
                        title={`Remove ${m.name}`}
                        className="text-fg-subtle hover:text-fg rounded p-0.5 opacity-0 pointer-coarse:opacity-100 transition-opacity group-hover/member:opacity-100 focus-visible:opacity-100"
                      >
                        <X size={11} aria-hidden />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {manage ? (
              <button
                type="button"
                aria-expanded={adding}
                onClick={() => {
                  setAdding((v) => !v)
                  setQuery('')
                }}
                className="text-fg-subtle hover:text-fg hover:border-border-strong border-border flex h-[1.25rem] items-center gap-1 self-start rounded-full border border-dashed px-2 text-aux transition-colors"
              >
                <UserPlus size={10} aria-hidden />
                {adding ? 'Done' : 'Add people'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {adding && manage && visibility === 'members' ? (
        <div className="border-border bg-surface enter-rise mt-1 flex flex-col rounded-lg border p-1">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (query) setQuery('')
                else setAdding(false)
              }
            }}
            placeholder="Find a person…"
            aria-label="Find a person"
            className="text-fg placeholder:text-fg-subtle h-10 w-full rounded-md bg-transparent px-2 text-ui outline-none"
          />
          <ul className="border-border flex max-h-[14rem] flex-col overflow-y-auto border-t pt-1" role="group" aria-label="People">
            {candidates.map((p) => {
              const on = memberIds.has(p.id)
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    disabled={busy}
                    onClick={() => (on ? remove(p.id) : add(p.id))}
                    className="hover:bg-surface-hover flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-ui transition-colors"
                  >
                    <span
                      className={cn(
                        'grid size-[0.875rem] shrink-0 place-items-center rounded-[4px] border',
                        on ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong',
                      )}
                    >
                      {on ? <Check size={10} strokeWidth={3} aria-hidden /> : null}
                    </span>
                    <Avatar name={p.name} size={16} />
                    <span className="text-fg truncate">
                      {p.name}
                      {p.id === currentUserId ? <span className="text-fg-subtle"> (you)</span> : null}
                    </span>
                  </button>
                </li>
              )
            })}
            {candidates.length === 0 ? (
              <li className="text-fg-subtle px-2 py-1.5 text-aux">
                {q ? 'Nobody by that name.' : 'Nobody else to add.'}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {manage && visibility !== 'lab' ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setPublishing(true)} className="self-start px-3">
            <Globe size={13} aria-hidden /> Publish to the lab
          </Button>
          <p className="text-fg-subtle text-aux leading-relaxed">One-way: a published subject cannot be made private again.</p>
        </div>
      ) : null}

      {publishing ? (
        <PublishDialog subjectRef={subject.ref} subjectTitle={subject.title} onCancel={closePublish} onConfirm={publish} />
      ) : null}
    </section>
  )
}

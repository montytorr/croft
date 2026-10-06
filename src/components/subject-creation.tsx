'use client'

import { usePathname, useRouter } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Globe, Lock, UserPlus, Users } from 'lucide-react'
import { Avatar } from '@/components/icons'
import { usePeople } from '@/components/people-context'
import { Spinner } from '@/components/spinner'
import { Button } from '@/components/ui/control'
import { StageGlyph } from '@/components/lab/stage'
import { TagChip } from '@/components/lab/tag-chip'
import { VISIBILITY_HINT } from '@/components/lab/visibility'
import { mutate } from '@/lib/api/mutate'
import { createsTodo, typingInField } from '@/lib/lab/ui-shortcuts'
import type { LabProject, Stage, Subject, SubjectVisibility, Tag } from '@/lib/lab/types'
import { matchProjectFilter } from '@/lib/lab/ui-colours'
import { cn } from '@/lib/utils'

type Ctx = { open: () => void }
const SubjectContext = createContext<Ctx>({ open: () => undefined })

export const useCreateSubject = () => useContext(SubjectContext)

const CHIP =
  'border-border text-fg-muted hover:border-border-strong hover:text-fg relative flex h-9 items-center gap-1.5 rounded-md border px-2 text-aux transition-colors'

const VISIBILITY_CHOICES: { value: SubjectVisibility; label: string; icon: typeof Lock }[] = [
  { value: 'lab', label: 'Lab', icon: Globe },
  { value: 'members', label: 'Members', icon: Users },
  { value: 'private', label: 'Private', icon: Lock },
]

/** The first planned stage, which is where an idea starts unless told otherwise. */
const defaultStage = (stages: Stage[]) => stages.find((s) => s.category === 'planned') ?? stages[0]

/**
 * The project the lab is filtered to, when the dialog opens over it: a subject
 * started while looking at Trig is almost always a Trig subject. Read at open,
 * from the address bar, so the provider needs no hook on the search params.
 */
const projectInView = (projects: LabProject[]): string => {
  if (typeof window === 'undefined' || window.location.pathname !== '/') return ''
  const match = matchProjectFilter(new URLSearchParams(window.location.search).get('project'), projects)
  return match && match !== 'none' ? match.id : ''
}

/**
 * New subject. Only the title is required: press c, name it, press enter, and
 * you are on its page with the write-up open to be started. Stage, project,
 * tags and owner have defaults a click away — the first planned stage, the
 * project the lab is filtered to (or none), no tags, and you.
 */
const CreateSubject = ({
  stages,
  tags,
  projects,
  onClose,
}: {
  stages: Stage[]
  tags: Tag[]
  projects: LabProject[]
  onClose: () => void
}) => {
  const router = useRouter()
  const { people, currentUserId } = usePeople()
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [stageId, setStageId] = useState(defaultStage(stages)?.id ?? '')
  const [picked, setPicked] = useState<string[]>([])
  const [owner, setOwner] = useState(currentUserId)
  const [projectId, setProjectId] = useState(() => projectInView(projects))
  const [visibility, setVisibility] = useState<SubjectVisibility>('lab')
  const [members, setMembers] = useState<string[]>([])
  const [pickingMembers, setPickingMembers] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stage = stages.find((s) => s.id === stageId)
  const restricted = visibility !== 'lab'
  // A private or members subject is filed by its owner: the server refuses one
  // filed for somebody else, who would then be the only one able to see it.
  const effectiveOwner = restricted ? currentUserId : owner
  const ownerName = people.find((p) => p.id === effectiveOwner)?.name ?? 'You'
  const project = projects.find((p) => p.id === projectId)
  const shared = visibility === 'members'
  const choice = VISIBILITY_CHOICES.find((c) => c.value === visibility) ?? VISIBILITY_CHOICES[0]!
  const VisibilityIcon = choice.icon
  // The owner is never a member of their own subject.
  const invitees = people.filter((p) => p.id !== currentUserId)
  const memberIds = shared ? members.filter((id) => id !== currentUserId) : []

  useEffect(() => {
    titleRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (!title.trim() || pending) return
    setPending(true)
    setError(null)
    const result = await mutate<Subject>('/api/v1/subjects', {
      method: 'POST',
      body: {
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(stageId ? { stage: stageId } : {}),
        tags: picked,
        ...(projectId ? { project: projectId } : {}),
        owner: effectiveOwner === currentUserId ? 'me' : effectiveOwner,
        ...(visibility !== 'lab' ? { visibility } : {}),
        ...(memberIds.length ? { members: memberIds } : {}),
      },
    })
    if (!result.ok) {
      setPending(false)
      setError(result.error)
      return
    }
    onClose()
    router.push(`/subjects/${result.data.number}`)
    router.refresh()
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" onClick={onClose}>
      <div className="scrim absolute inset-0" aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New subject"
        className="border-border bg-surface raised-lg enter-pop relative w-full max-w-[36rem] overflow-hidden rounded-xl border"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-fg-subtle px-5 pt-4 text-micro font-medium tracking-[0.06em] uppercase">New subject</p>
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          maxLength={300}
          placeholder="What is worth finding out?"
          aria-label="Title"
          className="font-display headline text-fg placeholder:text-fg-subtle w-full bg-transparent px-5 pt-1.5 pb-2 text-[1.25rem] outline-none"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
          rows={3}
          placeholder="Why it matters, where to start — or leave the write-up for later."
          className="writeup-sm text-fg placeholder:text-fg-subtle w-full resize-none bg-transparent px-5 pb-4 outline-none"
        />

        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1 px-5 pb-3" role="group" aria-label="Tags">
            {tags.map((tag) => {
              const on = picked.includes(tag.name)
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPicked((current) => (on ? current.filter((n) => n !== tag.name) : [...current, tag.name]))}
                  className={cn('rounded-full transition-opacity', !on && 'opacity-60 hover:opacity-100')}
                >
                  <TagChip tag={tag} active={on} />
                </button>
              )
            })}
          </div>
        ) : null}

        <div className="border-border bg-surface-raised/40 flex flex-wrap items-center gap-1.5 border-t px-5 py-3">
          {stages.length > 0 ? (
            <label className={CHIP}>
              {stage ? <StageGlyph stage={stage} /> : null}
              {stage?.name ?? 'Stage'}
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Stage"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {projects.length > 0 ? (
            <label className={CHIP}>
              <span
                className="size-[0.5rem] shrink-0 rounded-[2px]"
                style={{ backgroundColor: project?.color || 'transparent', boxShadow: project ? undefined : 'inset 0 0 0 1px var(--border-strong)' }}
                aria-hidden
              />
              {project?.name ?? 'No project'}
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Project"
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {restricted ? (
            <span className={cn(CHIP, 'hover:border-border hover:text-fg-muted')} title="A private or members subject is yours: you file it, you own it">
              <Avatar name={ownerName} size={16} />
              You
            </span>
          ) : (
            <label className={CHIP}>
              <Avatar name={ownerName} size={16} />
              {owner === currentUserId ? 'You' : ownerName}
              <select
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Owner"
              >
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === currentUserId ? `${p.name} (you)` : p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className={CHIP} title={VISIBILITY_HINT[visibility]}>
            <VisibilityIcon size={12} aria-hidden />
            {choice.label}
            <select
              value={visibility}
              onChange={(e) => {
                const next = e.target.value as SubjectVisibility
                setVisibility(next)
                setPickingMembers(next === 'members' && members.length === 0)
              }}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="Who can see it"
            >
              <option value="lab">Lab — everyone</option>
              <option value="members">Members — you and the people you add</option>
              <option value="private">Private — only the owner</option>
            </select>
          </label>

          {shared ? (
            <button
              type="button"
              aria-expanded={pickingMembers}
              onClick={() => setPickingMembers((v) => !v)}
              className={cn(CHIP, 'border-dashed')}
            >
              <UserPlus size={12} aria-hidden />
              {memberIds.length ? `${memberIds.length} ${memberIds.length === 1 ? 'person' : 'people'}` : 'Add people'}
            </button>
          ) : null}

          <span className="text-fg-subtle ml-auto hidden text-aux sm:block">↵ create</span>
          <Button variant="primary" size="sm" onClick={() => void submit()} disabled={!title.trim() || pending} className="px-3">
            {pending ? <Spinner /> : 'Create subject'}
          </Button>
        </div>

        {shared && pickingMembers ? (
          <div className="border-border enter-rise border-t px-5 py-3">
            <p className="text-fg-subtle mb-1.5 text-aux">Shared with</p>
            {invitees.length === 0 ? (
              <p className="text-fg-subtle text-aux">Nobody else to add yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1" role="group" aria-label="Members">
                {invitees.map((p) => {
                  const on = members.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setMembers((current) => (on ? current.filter((id) => id !== p.id) : [...current, p.id]))}
                      className={cn(
                        'flex h-[1.5rem] items-center gap-1.5 rounded-full border pr-2 pl-0.5 text-aux transition-colors',
                        on ? 'border-accent text-fg bg-surface-raised' : 'border-border text-fg-muted hover:text-fg hover:border-border-strong',
                      )}
                    >
                      <Avatar name={p.name} size={18} />
                      {p.name}
                      {on ? <Check size={10} strokeWidth={3} aria-hidden className="text-accent" /> : null}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : null}

        {error ? (
          <p className="text-danger bg-danger-subtle/60 border-border enter-rise border-t px-5 py-2 text-aux" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

/**
 * Holds the new-subject dialog once, at the root, so `c` works from anywhere
 * in the lab and any button can open it. On the todo surfaces `c` stays a new
 * todo (TaskCreationProvider); everywhere else it is a subject.
 */
export const SubjectCreationProvider = ({
  stages,
  tags,
  projects,
  children,
}: {
  stages: Stage[]
  tags: Tag[]
  projects: LabProject[]
  children: React.ReactNode
}) => {
  const [isOpen, setIsOpen] = useState(false)
  // Bumped on each open so the dialog remounts with fresh state.
  const [instance, setInstance] = useState(0)
  const pathname = usePathname()
  const labSurface = !createsTodo(pathname)

  const open = useCallback(() => {
    setInstance((n) => n + 1)
    setIsOpen(true)
  }, [])
  const close = useCallback(() => setIsOpen(false), [])

  useEffect(() => {
    if (!labSurface) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (typingInField()) return
      if (e.key === 'c') {
        e.preventDefault()
        setInstance((n) => n + 1)
        setIsOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [labSurface])

  const value = useMemo(() => ({ open }), [open])

  return (
    <SubjectContext.Provider value={value}>
      {children}
      {isOpen ? <CreateSubject key={instance} stages={stages} tags={tags} projects={projects} onClose={close} /> : null}
    </SubjectContext.Provider>
  )
}

import { Globe, Lock, Users } from 'lucide-react'
import type { SubjectVisibility } from '@/lib/lab/types'
import { cn } from '@/lib/utils'

export const VISIBILITY_LABEL: Record<SubjectVisibility, string> = {
  private: 'Private',
  members: 'Members',
  lab: 'Lab',
}

export const VISIBILITY_HINT: Record<SubjectVisibility, string> = {
  private: 'Only the owner sees it',
  members: 'The owner and the people added',
  lab: 'Everyone in the lab',
}

/** What a lock says when hovered: who can see the subject. */
export const visibilityTitle = (visibility: SubjectVisibility, members = 0) =>
  visibility === 'private'
    ? 'Private: only its owner sees it'
    : visibility === 'members'
      ? `Shared with ${members === 1 ? '1 person' : `${members} people`} besides its owner`
      : 'In the lab: everyone sees it'

/**
 * The small lock beside a subject on the board and in the list. Nothing for a
 * lab subject: the lab is the default, and marking the default would put a
 * mark on nearly every card.
 */
export const LockMark = ({
  visibility,
  members = 0,
  size = 11,
  className,
}: {
  visibility: SubjectVisibility | undefined
  members?: number
  size?: number
  className?: string
}) => {
  if (!visibility || visibility === 'lab') return null
  const Icon = visibility === 'members' ? Users : Lock
  return (
    <span
      className={cn('text-fg-subtle inline-flex shrink-0 items-center', className)}
      title={visibilityTitle(visibility, members)}
    >
      <Icon size={size} aria-hidden strokeWidth={2.25} />
      <span className="sr-only">{VISIBILITY_LABEL[visibility]}</span>
    </span>
  )
}

/**
 * "Private" or "Members · 3", for a subject's header. Set like the archived
 * mark beside it — a quiet outline, not a warning — because an unpublished
 * subject is a normal state, not a problem.
 */
export const VisibilityBadge = ({
  visibility,
  members = 0,
  className,
  always,
}: {
  visibility: SubjectVisibility | undefined
  members?: number
  className?: string
  /** Say "Lab" too. A header leaves the default unmarked; the subject's own state strip does not. */
  always?: boolean
}) => {
  if (!visibility || (visibility === 'lab' && !always)) return null
  const Icon = visibility === 'members' ? Users : visibility === 'lab' ? Globe : Lock
  return (
    <span
      className={cn(
        'border-border text-fg-muted inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] border px-2 text-aux leading-none font-medium',
        className,
      )}
      title={visibilityTitle(visibility, members)}
    >
      <Icon size={12} aria-hidden strokeWidth={2.25} />
      {visibility === 'members' ? (
        <>
          Members<span className="text-fg-subtle tabular-nums"> · {members}</span>
        </>
      ) : visibility === 'lab' ? (
        'Lab'
      ) : (
        'Private'
      )}
    </span>
  )
}

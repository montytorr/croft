'use client'

import Link from 'next/link'
import { LockMark } from '@/components/lab/visibility'
import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LabTodo } from '@/lib/lab/types'

/** An admin's colour is only trusted as a hex; anything else is the quiet grey. */
export const projectTone = (color: string | undefined | null) =>
  color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : 'var(--fg-subtle)'

/** The small square a lab project is drawn with everywhere: nav, lab, todos, board. */
export const ProjectDot = ({ color, className }: { color: string | undefined | null; className?: string }) => (
  <span
    aria-hidden
    className={cn('size-[0.4375rem] shrink-0 rounded-[2px]', className)}
    style={{ backgroundColor: projectTone(color) }}
  />
)

/**
 * The subject a todo belongs to: its project's colour, its ref, its title.
 * A link of its own, raised above a row's full-width link so both work.
 */
export const SubjectChip = ({
  subject,
  className,
  titleClassName,
}: {
  subject: NonNullable<LabTodo['subject']>
  className?: string
  /** Hide or cap the title at a breakpoint; the ref always shows. */
  titleClassName?: string
}) => (
  <Link
    href={`/subjects/${subject.number}`}
    onClick={(e) => e.stopPropagation()}
    onPointerDown={(e) => e.stopPropagation()}
    title={`${subject.ref} · ${subject.title}${subject.project ? ` · ${subject.project.name}` : ''}`}
    className={cn(
      'group/subject text-fg-muted hover:text-fg relative z-10 inline-flex min-w-0 items-center gap-1.5 rounded',
      'text-[0.6875rem] leading-none transition-colors duration-[var(--dur-1)]',
      className,
    )}
  >
    <ProjectDot color={subject.project?.color} />
    <span className="text-fg-subtle group-hover/subject:text-fg-muted shrink-0 font-mono text-[0.6875rem]">{subject.ref}</span>
    <LockMark visibility={subject.visibility} size={10} />
    <span className={cn('min-w-0 truncate', titleClassName)}>{subject.title}</span>
  </Link>
)

/**
 * Where a pushed todo's work is being done: `↗ CAIRN-331 · doing`. The status
 * is as of the last sync, so it stays grey rather than borrowing a status
 * colour it may no longer have.
 */
export const CairnBadge = ({
  cairnRef,
  cairnStatus,
  className,
}: {
  cairnRef: string | null
  cairnStatus: string | null
  className?: string
}) =>
  cairnRef ? (
    <span
      className={cn(
        'border-border text-fg-muted inline-flex h-[1.125rem] shrink-0 items-center gap-1 rounded border px-1.5 font-mono text-[0.6875rem]',
        className,
      )}
      title={`Pushed to Cairn as ${cairnRef}${cairnStatus ? `; ${cairnStatus} at the last sync` : ''}. Its status is Cairn's now.`}
    >
      <ArrowUpRight size={10} aria-hidden />
      {cairnRef}
      {cairnStatus ? <span className="text-fg-subtle">· {cairnStatus}</span> : null}
    </span>
  ) : null

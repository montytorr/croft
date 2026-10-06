'use client'

import Link from 'next/link'
import { Avatar } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { SubjectSummary } from '@/lib/lab/types'
import { ProjectLabel } from './project-label'
import { TagChip } from './tag-chip'
import { LockMark } from './visibility'

/** "2 of 5 todos done" as a short strip that fills as the work does. */
export const TodoTally = ({ todos, className }: { todos: SubjectSummary['todos']; className?: string }) => {
  const total = todos.open + todos.done
  if (total === 0) return null
  return (
    <span
      className={cn('text-fg-subtle inline-flex shrink-0 items-center gap-1.5 text-[0.6875rem] tabular-nums', className)}
      title={`${todos.open} open, ${todos.done} done`}
    >
      <span className="bg-border-strong/70 relative h-[3px] w-6 overflow-hidden rounded-full" aria-hidden>
        <span
          className="bg-status-done absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${(todos.done / total) * 100}%` }}
        />
      </span>
      {todos.done}/{total}
    </span>
  )
}

/**
 * A subject on the board. The title is the card; the ref, project, tags and
 * people are set small beneath it. A conclusion, when there is one, is quoted in the
 * reading serif — it is the most useful sentence the subject has.
 */
export const SubjectCard = ({
  subject,
  dragging,
  className,
}: {
  subject: SubjectSummary
  dragging?: boolean
  className?: string
}) => (
  <div
    className={cn(
      'surface-card surface-card-interactive group p-3',
      dragging && 'opacity-40',
      className,
    )}
  >
    <Link
      href={`/subjects/${subject.number}`}
      onClick={(e) => e.stopPropagation()}
      className="text-fg hover:text-fg block text-[0.875rem] leading-snug font-medium text-pretty"
      draggable={false}
    >
      {subject.title}
    </Link>

    {subject.conclusion ? (
      <p className="writeup-sm text-fg-muted mt-1.5 line-clamp-2 !text-[0.8125rem] !leading-snug">
        {subject.conclusion}
      </p>
    ) : null}

    {subject.tags.length > 0 ? (
      <div className="mt-2 flex flex-wrap gap-1">
        {subject.tags.slice(0, 3).map((tag) => (
          <TagChip key={tag.id} tag={tag} />
        ))}
        {subject.tags.length > 3 ? (
          <span className="text-fg-subtle self-center text-[0.6875rem]">+{subject.tags.length - 3}</span>
        ) : null}
      </div>
    ) : null}

    <div className="mt-2.5 flex items-center gap-2">
      <span className="text-fg-subtle font-mono text-[0.65625rem]">{subject.ref}</span>
      <LockMark visibility={subject.visibility} members={subject.members.length} size={10} />
      {subject.project ? <ProjectLabel project={subject.project} className="min-w-0 shrink" /> : null}
      <TodoTally todos={subject.todos} />
      {subject.owner ? (
        <span className="ml-auto" title={`Owner: ${subject.owner.name}`}>
          <Avatar name={subject.owner.name} size={18} />
        </span>
      ) : null}
    </div>
  </div>
)

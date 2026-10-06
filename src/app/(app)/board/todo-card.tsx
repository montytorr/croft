'use client'

import { useDraggable } from '@dnd-kit/core'
import Link from 'next/link'
import { MarkdownPreview } from '@/components/markdown'
import { Avatar, LabelPill, PriorityIcon, ProjectIcon, TypePill } from '@/components/icons'
import { cn } from '@/lib/utils'
import { HandoffBadge } from '@/components/handoff-badge'
import { SubjectChip } from '../todos/todo-bits'
import type { LabBoardTask } from './lab-lanes'

/**
 * A todo on `/board`: its ref, its title, and the subject it is for. A todo
 * handed off to another tracker is moved there, so it does not pick up; it
 * shows where it went instead.
 */
export const TodoCard = ({
  task,
  showProjectBadge,
  showSubject = true,
}: {
  task: LabBoardTask
  /** Which task project a card is filed in, for a board that spans several. */
  showProjectBadge?: boolean
  /** Off inside a subject's own lane, where it would repeat the lane's name. */
  showSubject?: boolean
}) => {
  const pushed = Boolean(task.handoff)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, disabled: pushed })
  const href = `/projects/${task.project_key}/tasks/${task.number}`
  const loud = task.priority === 'urgent' || task.priority === 'high'

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'surface-card surface-card-interactive group px-2.5 py-2',
        pushed ? 'cursor-default' : 'cursor-grab',
        'focus-visible:outline-accent/60 focus-visible:outline-2 focus-visible:outline-offset-1',
        // The card left behind while its preview is in the hand: a ghost of
        // where it came from, not a second copy.
        isDragging && 'opacity-40',
      )}
      title={task.handoff ? `Handed off to ${task.handoff.tracker} as ${task.handoff.ref}: moves there, not here` : undefined}
    >
      <div className="mb-1 flex h-[1rem] items-center gap-1.5">
        {showProjectBadge && <ProjectIcon size={11} projectKey={task.project_key} />}
        <Link
          href={href}
          className="text-fg-subtle hover:text-accent shrink-0 font-mono text-aux"
          onClick={(e) => e.stopPropagation()}
        >
          {task.project_key}-{task.number}
        </Link>
        {loud ? <PriorityIcon priority={task.priority} /> : null}
        {task.type !== 'feature' ? <TypePill type={task.type} /> : null}
        <span className="ml-auto flex items-center gap-1">
          {task.claimed_by && (
            <span title={`Held by ${task.claimed_by}`}>
              <Avatar name={task.claimed_by} size={15} />
            </span>
          )}
          {task.assignee && (
            <span title={`Assignee: ${task.assignee.name}`}>
              <Avatar name={task.assignee.name} size={15} />
            </span>
          )}
        </span>
      </div>

      <Link
        href={href}
        className="text-fg hover:text-accent line-clamp-3 block text-ui leading-snug font-medium transition-colors duration-[var(--dur-1)]"
        onClick={(e) => e.stopPropagation()}
      >
        {task.title}
      </Link>

      {task.preview ? (
        <div className="mt-1">
          <MarkdownPreview lines={2}>{task.preview}</MarkdownPreview>
        </div>
      ) : null}

      {task.blocked_reason ? (
        <p className="text-danger mt-1 line-clamp-1 text-aux">blocked: {task.blocked_reason}</p>
      ) : null}

      {(showSubject && task.subject) || pushed || task.has_resolution || task.labels.length > 0 ? (
        <div className="border-border/70 mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t pt-1.5">
          {showSubject && task.subject ? (
            <SubjectChip subject={task.subject} className="max-w-full" />
          ) : null}
          <HandoffBadge handoff={task.handoff} />
          {task.has_resolution ? (
            <span className="text-status-done text-aux">{task.resolution_kind ?? 'resolved'}</span>
          ) : null}
          {task.labels.slice(0, 3).map((l) => (
            <LabelPill key={l}>{l}</LabelPill>
          ))}
        </div>
      ) : null}
    </div>
  )
}

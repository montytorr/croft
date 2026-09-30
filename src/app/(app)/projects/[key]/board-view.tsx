'use client'

import { useDraggable } from '@dnd-kit/core'
import Link from 'next/link'
import { MarkdownPreview } from '@/components/markdown'
import { Avatar, LabelPill, PriorityIcon, ProjectIcon, TypePill } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { TaskListItem } from '@/lib/data'

/**
 * A todo on the todo board (`/board`). The per-project board that also drew
 * these went with the Projects menu; the card stayed for the one that is left.
 */
export const Card = ({
  task,
  projectKey,
  showProjectBadge,
}: {
  task: TaskListItem
  projectKey: string
  /** Which project a card belongs to, for a board that spans several. */
  showProjectBadge?: boolean
}) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id })

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'surface-card surface-card-interactive group cursor-grab p-2.5',
        'focus-visible:outline-accent/60 focus-visible:outline-2 focus-visible:outline-offset-1',
        // The card left behind while its preview is in the hand: a ghost of
        // where it came from, not a second copy.
        isDragging && 'opacity-40',
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        {showProjectBadge && <ProjectIcon size={11} projectKey={projectKey} />}
        <Link
          href={`/projects/${projectKey}/tasks/${task.number}`}
          className="text-fg-subtle hover:text-accent shrink-0 font-mono text-[0.6875rem]"
          onClick={(e) => e.stopPropagation()}
        >
          {projectKey}-{task.number}
        </Link>
        <TypePill type={task.type} />
        <PriorityIcon priority={task.priority} />
        <span className="ml-auto flex items-center gap-1">
          {task.assignee && (
            <span title={`Assignee: ${task.assignee.name}`}>
              <Avatar name={task.assignee.name} size={16} />
            </span>
          )}
          {task.claimed_by && (
            <span title={`Held by ${task.claimed_by}`}>
              <Avatar name={task.claimed_by} size={16} />
            </span>
          )}
        </span>
      </div>

      <Link
        href={`/projects/${projectKey}/tasks/${task.number}`}
        className="block text-[0.8125rem] leading-snug font-medium"
        onClick={(e) => e.stopPropagation()}
      >
        {task.title}
      </Link>

      {task.preview ? (
        <div className="mt-1.5">
          <MarkdownPreview lines={2}>{task.preview}</MarkdownPreview>
        </div>
      ) : null}

      {task.has_resolution ? (
        <p className="text-status-done mt-1.5 line-clamp-2 text-[0.6875rem] leading-snug">
          {task.resolution_kind ?? 'resolved'}
        </p>
      ) : null}

      {task.blocked_reason ? (
        <p className="text-danger mt-1.5 line-clamp-1 text-[0.6875rem]">blocked: {task.blocked_reason}</p>
      ) : null}

      {task.labels.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.labels.slice(0, 3).map((l) => (
            <LabelPill key={l}>{l}</LabelPill>
          ))}
        </div>
      )}
    </div>
  )
}

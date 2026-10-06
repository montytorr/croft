'use client'

import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowRight, Check, GripVertical, Trash2, X } from 'lucide-react'
import { InlineInput } from '@/components/ui/control'
import { ProjectLabel } from '@/components/lab/project-label'
import { mutate } from '@/lib/api/mutate'
import type { LabProject } from '@/lib/lab/types'
import { parseHandoffDraft } from '@/lib/lab/ui-colours'
import { cn } from '@/lib/utils'
import { SettingsCard } from './settings-card'
import { AddRow, EditableName, HANDOFF_HINT, HandoffInputs, Swatch } from './lab-controls'

type Patch = {
  name?: string
  color?: string
  handoffTracker?: string | null
  handoffTarget?: string | null
}

/**
 * Where a lab project's todos are handed off: a tracker and a target in it.
 * Unlike a name it can be emptied, which clears both: a project without one
 * keeps its todos in Croft until someone says where they go.
 */
const HandoffField = ({
  tracker,
  target,
  disabled,
  label,
  onCommit,
}: {
  tracker: string | null
  target: string | null
  disabled?: boolean
  label: string
  onCommit: (handoff: { handoffTracker: string | null; handoffTarget: string | null }) => Promise<boolean>
}) => {
  const [editing, setEditing] = useState(false)
  const [trackerDraft, setTrackerDraft] = useState(tracker ?? '')
  const [targetDraft, setTargetDraft] = useState(target ?? '')
  const [error, setError] = useState<string | null>(null)
  const set = tracker && target ? `${tracker} · ${target}` : null

  if (!editing || disabled) {
    if (disabled && !set) return <span className="text-fg-subtle shrink-0 text-aux">no hand-off</span>
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setTrackerDraft(tracker ?? '')
          setTargetDraft(target ?? '')
          setError(null)
          setEditing(true)
        }}
        aria-label={label}
        title={
          disabled
            ? `Todos are handed off to ${set}`
            : set
              ? `croft handoff sends this project's todos to ${set}. Click to change; empty both to clear.`
              : HANDOFF_HINT
        }
        className={cn(
          'flex h-[1.5rem] shrink-0 items-center gap-1 rounded px-1.5 text-aux enabled:hover:bg-surface-hover disabled:cursor-default',
          set ? 'text-fg-muted font-mono' : 'text-fg-subtle',
        )}
      >
        <ArrowRight size={11} aria-hidden className="text-fg-subtle" />
        {set ?? 'Hand-off'}
      </button>
    )
  }

  const commit = async () => {
    const next = parseHandoffDraft(trackerDraft, targetDraft)
    if (!next.ok) return setError(next.error)
    if (next.tracker === tracker && next.target === target) return setEditing(false)
    setError(null)
    if (await onCommit({ handoffTracker: next.tracker, handoffTarget: next.target })) setEditing(false)
  }

  return (
    <form
      role="group"
      aria-label={label}
      className="flex shrink-0 flex-wrap items-center justify-end gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        void commit()
      }}
      onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
    >
      <HandoffInputs
        autoFocus
        tracker={trackerDraft}
        target={targetDraft}
        onTracker={setTrackerDraft}
        onTarget={setTargetDraft}
      />
      <button type="submit" aria-label="Save hand-off" className="text-fg-muted hover:text-fg grid size-6 place-items-center rounded">
        <Check size={13} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => setEditing(false)}
        className="text-fg-subtle hover:text-fg grid size-6 place-items-center rounded"
      >
        <X size={13} aria-hidden />
      </button>
      <p className={cn('basis-full text-right text-aux', error ? 'text-danger' : 'text-fg-subtle')}>{error ?? HANDOFF_HINT}</p>
    </form>
  )
}

const ProjectRow = ({
  project,
  canEdit,
  onPatch,
  onDelete,
  error,
}: {
  project: LabProject
  canEdit: boolean
  onPatch: (id: string, body: Patch) => Promise<boolean>
  onDelete: (project: LabProject) => void
  error?: string
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
    disabled: !canEdit,
  })
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      className={cn('bg-surface relative', isDragging && 'z-10 shadow-[var(--shadow-md)]')}
    >
      <div className="row-hover group flex min-h-[2.75rem] items-center gap-2.5 px-3 py-1.5 md:px-4">
        {canEdit ? (
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${project.name}`}
            className="text-fg-subtle hover:text-fg -ml-1 grid size-6 shrink-0 cursor-grab place-items-center rounded active:cursor-grabbing"
          >
            <GripVertical size={14} aria-hidden />
          </button>
        ) : null}
        <Swatch
          value={project.color}
          disabled={!canEdit}
          label={`Colour of ${project.name}`}
          onCommit={(color) => void onPatch(project.id, { color })}
        />
        <div className="flex min-w-0 flex-1 items-center">
          {canEdit ? (
            <EditableName
              value={project.name}
              label={`Rename ${project.name}`}
              onCommit={(name) => onPatch(project.id, { name })}
            />
          ) : (
            <ProjectLabel project={project} />
          )}
        </div>
        <HandoffField
          tracker={project.handoff_tracker}
          target={project.handoff_target}
          disabled={!canEdit}
          label={`Hand-off of ${project.name}`}
          onCommit={(handoff) => onPatch(project.id, handoff)}
        />
        {canEdit ? (
          <button
            type="button"
            onClick={() => onDelete(project)}
            aria-label={`Delete ${project.name}`}
            className="text-fg-subtle hover:text-danger grid size-6 shrink-0 place-items-center rounded transition-colors md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
          >
            <Trash2 size={13} aria-hidden />
          </button>
        ) : null}
      </div>
      {error ? <p className="text-danger enter-rise px-4 pb-2 text-aux md:pl-[4.25rem]">{error}</p> : null}
    </li>
  )
}

/**
 * The lab's projects: the short list a subject can belong to — Trig, Croft,
 * Dispofi — each with where its todos are handed off to. Curated like
 * the tags, ordered like the stages. A project subjects still belong to
 * cannot be deleted; the row says so rather than the page.
 */
export const LabProjectsSection = ({ projects: initial, canEdit }: { projects: LabProject[]; canEdit: boolean }) => {
  const router = useRouter()
  const [projects, setProjects] = useState(initial)
  const [prev, setPrev] = useState(initial)
  if (initial !== prev) {
    setPrev(initial)
    setProjects(initial)
  }
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const write = async (url: string, init: Parameters<typeof mutate>[1], rowId?: string) => {
    setMessage(null)
    setRowError(null)
    const result = await mutate(url, init)
    if (!result.ok) {
      if (rowId) setRowError({ id: rowId, message: result.error })
      else setMessage(result.error)
      return false
    }
    router.refresh()
    return true
  }

  const patch = (id: string, body: Patch) => write(`/api/v1/lab-projects/${id}`, { method: 'PATCH', body }, id)

  const remove = async (project: LabProject) => {
    if (!window.confirm(`Delete the project “${project.name}”?`)) return
    setMessage(null)
    setRowError(null)
    const result = await mutate(`/api/v1/lab-projects/${project.id}`, { method: 'DELETE' })
    if (!result.ok) {
      setRowError({
        id: project.id,
        message:
          result.code === 'project_in_use'
            ? `Subjects still belong to “${project.name}”. Move them to another project, or to none, first.`
            : result.error,
      })
      return
    }
    router.refresh()
  }

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const previous = projects
    const next = arrayMove(
      projects,
      projects.findIndex((p) => p.id === active.id),
      projects.findIndex((p) => p.id === over.id),
    )
    setProjects(next)
    const ok = await write('/api/v1/lab-projects/reorder', { method: 'POST', body: { ids: next.map((p) => p.id) } })
    if (!ok) setProjects(previous)
  }

  return (
    <div id="lab-projects" className="scroll-mt-16">
    <SettingsCard
      title="Lab projects"
      flush
      description={
        canEdit
          ? 'What a subject belongs to, and where its todos are sent. Drag to reorder.'
          : 'What a subject belongs to, and where its todos are sent. Only an administrator can change them.'
      }
      footer={message ? <p className="text-danger enter-rise text-aux">{message}</p> : undefined}
    >
      {projects.length === 0 ? (
        <p className="text-fg-subtle px-4 py-4 text-aux">No projects yet.</p>
      ) : (
        <DndContext id="lab-projects" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
            <ul className="divide-border divide-y">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  canEdit={canEdit}
                  onPatch={patch}
                  onDelete={remove}
                  error={rowError?.id === project.id ? rowError.message : undefined}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      {canEdit ? (
        <AddRow
          placeholder="New project…"
          withHandoff
          onAdd={({ name, color, handoffTracker, handoffTarget }) =>
            write('/api/v1/lab-projects', {
              method: 'POST',
              body: { name, color, ...(handoffTracker && handoffTarget ? { handoffTracker, handoffTarget } : {}) },
            })
          }
        />
      ) : null}
    </SettingsCard>
    </div>
  )
}

'use client'

import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowRight, GripVertical, Trash2 } from 'lucide-react'
import { InlineInput } from '@/components/ui/control'
import { ProjectLabel } from '@/components/lab/project-label'
import { mutate } from '@/lib/api/mutate'
import type { LabProject } from '@/lib/lab/types'
import { normaliseCairnKey } from '@/lib/lab/ui-colours'
import { cn } from '@/lib/utils'
import { SettingsCard } from './settings-card'
import { AddRow, EditableName, Swatch } from './lab-controls'

type Patch = { name?: string; color?: string; cairnKey?: string | null }

/**
 * The Cairn project a lab project's todos are pushed to. Unlike a name it can
 * be emptied, which clears it: a project without a key keeps its todos in
 * Croft until someone says where they go.
 */
const CairnKeyField = ({
  value,
  disabled,
  label,
  onCommit,
}: {
  value: string | null
  disabled?: boolean
  label: string
  onCommit: (key: string | null) => Promise<boolean>
}) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')

  if (!editing || disabled) {
    if (disabled && !value) return <span className="text-fg-subtle/70 shrink-0 text-[0.6875rem]">no Cairn key</span>
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setDraft(value ?? '')
          setEditing(true)
        }}
        title={
          disabled
            ? `Todos go to Cairn project ${value}`
            : value
              ? `croft push sends this project's todos to ${value}. Click to change; empty it to clear.`
              : 'Set the Cairn project that receives these todos on croft push'
        }
        className={cn(
          'flex h-[1.5rem] shrink-0 items-center gap-1 rounded px-1.5 text-[0.6875rem] enabled:hover:bg-surface-hover disabled:cursor-default',
          value ? 'text-fg-muted font-mono' : 'text-fg-subtle',
        )}
      >
        <ArrowRight size={11} aria-hidden className="text-fg-subtle" />
        {value ?? 'Cairn key'}
      </button>
    )
  }

  const commit = async () => {
    const next = normaliseCairnKey(draft)
    if (next === value) return setEditing(false)
    if (await onCommit(next)) setEditing(false)
  }

  return (
    <InlineInput
      autoFocus
      value={draft}
      aria-label={label}
      placeholder="none"
      maxLength={10}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value.toUpperCase())}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit()
        if (e.key === 'Escape') setEditing(false)
      }}
      className="h-[1.625rem] w-[6.5rem] shrink-0 font-mono text-[0.75rem] uppercase"
    />
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
        <CairnKeyField
          value={project.cairn_key}
          disabled={!canEdit}
          label={`Cairn key of ${project.name}`}
          onCommit={(cairnKey) => onPatch(project.id, { cairnKey })}
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
      {error ? <p className="text-danger enter-rise px-4 pb-2 text-[0.75rem] md:pl-[4.25rem]">{error}</p> : null}
    </li>
  )
}

/**
 * The lab's projects: the short list a subject can belong to — Trig, Croft,
 * Dispofi — each with the Cairn project its todos are pushed to. Curated like
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
          ? 'What a subject belongs to. The Cairn key is where croft push sends its todos when no --to is given. Drag to reorder.'
          : 'What a subject belongs to, and the Cairn project its todos are pushed to. Only an administrator can change them.'
      }
      footer={message ? <p className="text-danger enter-rise text-[0.75rem]">{message}</p> : undefined}
    >
      {projects.length === 0 ? (
        <p className="text-fg-subtle px-4 py-4 text-[0.75rem]">No projects yet.</p>
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
          withCairnKey
          onAdd={({ name, color, cairnKey }) =>
            write('/api/v1/lab-projects', { method: 'POST', body: { name, color, ...(cairnKey ? { cairnKey } : {}) } })
          }
        />
      ) : null}
    </SettingsCard>
    </div>
  )
}

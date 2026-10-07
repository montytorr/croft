'use client'

import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { GripVertical, Trash2 } from 'lucide-react'
import { CATEGORY_LABEL, StageGlyph } from '@/components/lab/stage'
import { TagChip } from '@/components/lab/tag-chip'
import { mutate } from '@/lib/api/mutate'
import { STAGE_CATEGORIES, type LabProject, type Stage, type StageCategory, type Tag } from '@/lib/lab/types'
import { Select } from '@/components/ui/control'
import { cn } from '@/lib/utils'
import { SettingsCard } from './settings-card'
import { AddRow, EditableName, LabColours, Swatch } from './lab-controls'
import { LabProjectsSection } from './lab-projects-section'

const StageRow = ({
  stage,
  canEdit,
  onPatch,
  onDelete,
  error,
}: {
  stage: Stage
  canEdit: boolean
  onPatch: (id: string, body: Partial<Pick<Stage, 'name' | 'color' | 'category'>>) => Promise<boolean>
  onDelete: (stage: Stage) => void
  error?: string
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.id,
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
            aria-label={`Reorder ${stage.name}`}
            className="text-fg-subtle hover:text-fg -ml-1 grid size-6 shrink-0 cursor-grab place-items-center rounded active:cursor-grabbing"
          >
            <GripVertical size={14} aria-hidden />
          </button>
        ) : null}
        <StageGlyph stage={stage} size={15} />
        <Swatch
          value={stage.color}
          disabled={!canEdit}
          label={`Colour of ${stage.name}`}
          onCommit={(color) => void onPatch(stage.id, { color })}
        />
        <div className="flex min-w-0 flex-1 items-center">
          <EditableName
            value={stage.name}
            disabled={!canEdit}
            label={`Rename ${stage.name}`}
            onCommit={(name) => onPatch(stage.id, { name })}
          />
        </div>
        {canEdit ? (
          <Select
            size="sm"
            value={stage.category}
            onChange={(e) => void onPatch(stage.id, { category: e.target.value as StageCategory })}
            aria-label={`Category of ${stage.name}`}
          >
            {STAGE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-fg-subtle shrink-0 text-aux">{CATEGORY_LABEL[stage.category]}</span>
        )}
        {canEdit ? (
          <button
            type="button"
            onClick={() => onDelete(stage)}
            aria-label={`Delete ${stage.name}`}
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
 * The lab's curated lists: the stages every subject moves along, in
 * pipeline order, the projects subjects belong to, and the tags they carry. Administrators shape them;
 * everyone else sees them as they are. A stage's category is what gives it
 * meaning to the rest of Croft — entering a completed or dropped one asks for
 * a conclusion — so it is set explicitly rather than guessed from the name.
 */
export const LabSection = ({
  stages: initialStages,
  tags,
  projects,
  canEdit,
}: {
  stages: Stage[]
  tags: Tag[]
  projects: LabProject[]
  canEdit: boolean
}) => {
  const router = useRouter()
  const [stages, setStages] = useState(initialStages)
  const [prev, setPrev] = useState(initialStages)
  if (initialStages !== prev) {
    setPrev(initialStages)
    setStages(initialStages)
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

  const patchStage = (id: string, body: Record<string, unknown>) =>
    write(`/api/v1/stages/${id}`, { method: 'PATCH', body }, id)

  const deleteStage = async (stage: Stage) => {
    if (!window.confirm(`Delete the stage “${stage.name}”?`)) return
    setMessage(null)
    setRowError(null)
    const result = await mutate(`/api/v1/stages/${stage.id}`, { method: 'DELETE' })
    if (!result.ok) {
      setRowError({
        id: stage.id,
        message:
          result.code === 'stage_in_use'
            ? `Subjects are still at “${stage.name}”. Move them to another stage first, then delete it.`
            : result.error,
      })
      return
    }
    router.refresh()
  }

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const previous = stages
    const next = arrayMove(
      stages,
      stages.findIndex((s) => s.id === active.id),
      stages.findIndex((s) => s.id === over.id),
    )
    setStages(next)
    const ok = await write('/api/v1/stages/reorder', { method: 'POST', body: { ids: next.map((s) => s.id) } })
    if (!ok) setStages(previous)
  }

  const patchTag = (id: string, body: Record<string, unknown>) => write(`/api/v1/tags/${id}`, { method: 'PATCH', body }, id)
  const deleteTag = async (tag: Tag) => {
    if (!window.confirm(`Delete the tag “${tag.name}”? It comes off every subject that carries it.`)) return
    await write(`/api/v1/tags/${tag.id}`, { method: 'DELETE' }, tag.id)
  }

  return (
    <>
      <LabColours />

      <SettingsCard
        title="Lab stages"
        flush
        description={
          canEdit
            ? 'Subjects move down these stages. Drag to reorder.'
            : 'Subjects move down these stages. Only an administrator can change them.'
        }
        footer={message ? <p className="text-danger enter-rise text-aux">{message}</p> : undefined}
      >
        {stages.length === 0 ? (
          <p className="text-fg-subtle px-4 py-4 text-aux">No stages yet.</p>
        ) : (
          <DndContext id="lab-stages" sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={stages.map((s) => s.id)} strategy={verticalListSortingStrategy}>
              <ul className="divide-border divide-y">
                {stages.map((stage) => (
                  <StageRow
                    key={stage.id}
                    stage={stage}
                    canEdit={canEdit}
                    onPatch={patchStage}
                    onDelete={deleteStage}
                    error={rowError?.id === stage.id ? rowError.message : undefined}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        {canEdit ? (
          <AddRow
            placeholder="New stage…"
            withCategory
            onAdd={({ name, color, category }) => write('/api/v1/stages', { method: 'POST', body: { name, color, category } })}
          />
        ) : null}
      </SettingsCard>

      <LabProjectsSection projects={projects} canEdit={canEdit} />

      <SettingsCard
        title="Lab tags"
        flush
        description={
          canEdit
            ? 'The tags a subject can carry. A short list stays useful.'
            : 'The tags a subject can carry. Only an administrator can change them.'
        }
      >
        {tags.length === 0 ? (
          <p className="text-fg-subtle px-4 py-4 text-aux">No tags yet.</p>
        ) : (
          <ul className="divide-border divide-y">
            {tags.map((tag) => (
              <li key={tag.id}>
                <div className="row-hover group flex min-h-[2.5rem] items-center gap-2.5 px-3 py-1.5 md:px-4">
                  <Swatch
                    value={tag.color}
                    disabled={!canEdit}
                    label={`Colour of ${tag.name}`}
                    onCommit={(color) => void patchTag(tag.id, { color })}
                  />
                  {canEdit ? (
                    <div className="flex min-w-0 flex-1 items-center">
                      <EditableName value={tag.name} label={`Rename ${tag.name}`} onCommit={(name) => patchTag(tag.id, { name })} />
                    </div>
                  ) : (
                    <TagChip tag={tag} />
                  )}
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => void deleteTag(tag)}
                      aria-label={`Delete ${tag.name}`}
                      className="text-fg-subtle hover:text-danger ml-auto grid size-6 shrink-0 place-items-center rounded transition-colors md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  ) : null}
                </div>
                {rowError?.id === tag.id ? (
                  <p className="text-danger enter-rise px-4 pb-2 text-aux">{rowError.message}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <AddRow
            placeholder="New tag…"
            onAdd={({ name, color }) => write('/api/v1/tags', { method: 'POST', body: { name, color } })}
          />
        ) : null}
      </SettingsCard>
    </>
  )
}

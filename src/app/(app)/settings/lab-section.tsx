'use client'

import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { Button, InlineInput } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { CATEGORY_LABEL, StageGlyph } from '@/components/lab/stage'
import { TagChip } from '@/components/lab/tag-chip'
import { mutate } from '@/lib/api/mutate'
import { STAGE_CATEGORIES, type Stage, type StageCategory, type Tag } from '@/lib/lab/types'
import { cn } from '@/lib/utils'
import { SettingsCard } from './settings-card'

/**
 * Starting colours that hold up on paper and on peat alike — mid-tones, none
 * of them heather, which is the accent's alone.
 */
const PRESETS = ['#5a6f8c', '#8a4f1c', '#4a7a2c', '#7d5d50', '#2f7a6e', '#5b4bb0', '#2f62a8', '#a14a22', '#b08a2e', '#6f666b']

const HEX = /^#[0-9a-f]{6}$/i

/** A colour swatch that is its own picker; commits when the picker closes. */
const Swatch = ({
  value,
  disabled,
  label,
  onCommit,
}: {
  value: string
  disabled?: boolean
  label: string
  onCommit: (hex: string) => void
}) => {
  const [draft, setDraft] = useState(HEX.test(value) ? value : '#6f666b')
  const [prev, setPrev] = useState(value)
  if (value !== prev) {
    setPrev(value)
    if (HEX.test(value)) setDraft(value)
  }
  return (
    <label
      className={cn(
        'border-border-strong relative block size-[1.125rem] shrink-0 overflow-hidden rounded-full border',
        !disabled && 'cursor-pointer hover:ring-2 hover:ring-[var(--border-strong)]',
      )}
      style={{ backgroundColor: draft }}
      title={disabled ? draft : `${label}: ${draft}`}
    >
      <input
        type="color"
        list="croft-lab-colours"
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
      />
    </label>
  )
}

/** A name that turns into a field on click; Enter saves, Escape puts it back. */
const EditableName = ({
  value,
  disabled,
  label,
  onCommit,
}: {
  value: string
  disabled?: boolean
  label: string
  onCommit: (name: string) => Promise<boolean>
}) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  if (!editing || disabled) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        className="text-fg min-w-0 truncate rounded px-1 text-left text-[0.8125rem] enabled:hover:bg-surface-hover disabled:cursor-default"
        title={disabled ? undefined : 'Rename'}
      >
        {value}
      </button>
    )
  }

  const commit = async () => {
    const next = draft.trim()
    if (!next || next === value) return setEditing(false)
    if (await onCommit(next)) setEditing(false)
  }

  return (
    <InlineInput
      autoFocus
      value={draft}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit()
        if (e.key === 'Escape') setEditing(false)
      }}
      className="h-[1.625rem] min-w-0 flex-1"
    />
  )
}

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
          <select
            value={stage.category}
            onChange={(e) => void onPatch(stage.id, { category: e.target.value as StageCategory })}
            aria-label={`Category of ${stage.name}`}
            className="border-border bg-surface text-fg-muted hover:border-border-strong h-[1.625rem] shrink-0 rounded-md border px-2 text-[0.75rem]"
          >
            {STAGE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-fg-subtle shrink-0 text-[0.75rem]">{CATEGORY_LABEL[stage.category]}</span>
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
      {error ? <p className="text-danger enter-rise px-4 pb-2 text-[0.75rem] md:pl-[4.25rem]">{error}</p> : null}
    </li>
  )
}

/** The add row shared by stages and tags. */
const AddRow = ({
  placeholder,
  withCategory,
  onAdd,
}: {
  placeholder: string
  withCategory?: boolean
  onAdd: (input: { name: string; color: string; category: StageCategory }) => Promise<boolean>
}) => {
  const [name, setName] = useState('')
  const [color, setColor] = useState(PRESETS[0]!)
  const [category, setCategory] = useState<StageCategory>('planned')
  const [pending, setPending] = useState(false)

  const add = async () => {
    if (!name.trim() || pending) return
    setPending(true)
    const ok = await onAdd({ name: name.trim(), color, category })
    setPending(false)
    if (ok) {
      setName('')
      setColor(PRESETS[(PRESETS.indexOf(color) + 1) % PRESETS.length]!)
    }
  }

  return (
    <div className="border-border flex flex-wrap items-center gap-2 border-t px-3 py-2.5 md:px-4">
      <Swatch value={color} label="Colour" onCommit={setColor} />
      <InlineInput
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void add()}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-[1.75rem] min-w-[10rem] flex-1"
      />
      {withCategory ? (
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as StageCategory)}
          aria-label="Category"
          className="border-border bg-surface text-fg-muted h-[1.75rem] rounded-md border px-2 text-[0.75rem]"
        >
          {STAGE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      ) : null}
      <Button size="sm" variant="primary" onClick={() => void add()} disabled={!name.trim() || pending} className="h-[1.75rem] px-3">
        {pending ? <Spinner /> : <><Plus size={13} aria-hidden /> Add</>}
      </Button>
    </div>
  )
}

/**
 * The lab's two curated lists: the stages every subject moves along, in
 * pipeline order, and the tags subjects can carry. Administrators shape them;
 * everyone else sees them as they are. A stage's category is what gives it
 * meaning to the rest of Croft — entering a completed or dropped one asks for
 * a conclusion — so it is set explicitly rather than guessed from the name.
 */
export const LabSection = ({ stages: initialStages, tags, canEdit }: { stages: Stage[]; tags: Tag[]; canEdit: boolean }) => {
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
      <datalist id="croft-lab-colours">
        {PRESETS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <SettingsCard
        title="Lab stages"
        flush
        description={
          canEdit
            ? 'The pipeline every subject moves along, top to bottom. Drag to reorder. A completed or dropped stage asks for a conclusion on the way in.'
            : 'The pipeline every subject moves along. Only an administrator can change it.'
        }
        footer={message ? <p className="text-danger enter-rise text-[0.75rem]">{message}</p> : undefined}
      >
        {stages.length === 0 ? (
          <p className="text-fg-subtle px-4 py-4 text-[0.75rem]">No stages yet.</p>
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

      <SettingsCard
        title="Lab tags"
        flush
        description={
          canEdit
            ? 'The curated tags a subject can carry. Keeping the list short is what keeps it useful.'
            : 'The curated tags a subject can carry. Only an administrator can change them.'
        }
      >
        {tags.length === 0 ? (
          <p className="text-fg-subtle px-4 py-4 text-[0.75rem]">No tags yet.</p>
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
                  <p className="text-danger enter-rise px-4 pb-2 text-[0.75rem]">{rowError.message}</p>
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

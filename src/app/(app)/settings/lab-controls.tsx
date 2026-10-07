'use client'

import { useId, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button, InlineInput, Select } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { CATEGORY_LABEL } from '@/components/lab/stage'
import { STAGE_CATEGORIES, type StageCategory } from '@/lib/lab/types'
import { HANDOFF_TRACKER_SUGGESTIONS, LAB_PRESETS as PRESETS, parseHandoffDraft } from '@/lib/lab/ui-colours'
import { cn } from '@/lib/utils'

/** The datalist every lab swatch offers as its starting colours. Render once per page. */
export const LabColours = () => (
  <datalist id="croft-lab-colours">
    {PRESETS.map((c) => (
      <option key={c} value={c} />
    ))}
  </datalist>
)

const HEX = /^#[0-9a-f]{6}$/i

/** A colour swatch that is its own picker; commits when the picker closes. */
export const Swatch = ({
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
        'border-border-strong relative block size-6 shrink-0 overflow-hidden rounded-full border',
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
        className="control-overlay"
      />
    </label>
  )
}

/** A name that turns into a field on click; Enter saves, Escape puts it back. */
export const EditableName = ({
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
        className="text-fg min-h-6 min-w-0 truncate rounded px-1 text-left text-ui enabled:hover:bg-surface-hover disabled:cursor-default"
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
      className="min-w-0 flex-1"
    />
  )
}

export const HANDOFF_HINT =
  "Where `croft handoff` sends this project's todos: a tracker and a target in it, e.g. cairn + CAIRN, or github + owner/repo."

/** The two inputs of a hand-off: a tracker (free text, with suggestions) and a target in it. */
export const HandoffInputs = ({
  tracker,
  target,
  onTracker,
  onTarget,
  onKeyDown,
  autoFocus,
  className,
}: {
  tracker: string
  target: string
  onTracker: (value: string) => void
  onTarget: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  autoFocus?: boolean
  className?: string
}) => {
  const listId = useId()
  return (
    <>
      <InlineInput
        autoFocus={autoFocus}
        value={tracker}
        list={listId}
        onChange={(e) => onTracker(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="tracker"
        aria-label="Hand-off tracker"
        title={HANDOFF_HINT}
        maxLength={32}
        spellCheck={false}
        autoCapitalize="none"
        className={cn('w-[6.5rem]', className)}
      />
      <datalist id={listId}>
        {HANDOFF_TRACKER_SUGGESTIONS.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <InlineInput
        value={target}
        onChange={(e) => onTarget(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="target"
        aria-label="Hand-off target"
        title={HANDOFF_HINT}
        maxLength={100}
        spellCheck={false}
        autoCapitalize="none"
        className={cn('w-[8.5rem]', className)}
      />
    </>
  )
}

/** The add row shared by stages, tags and projects. */
export const AddRow = ({
  placeholder,
  withCategory,
  withHandoff,
  onAdd,
}: {
  placeholder: string
  withCategory?: boolean
  /** An optional hand-off (tracker and target) beside the name (lab projects). */
  withHandoff?: boolean
  onAdd: (input: {
    name: string
    color: string
    category: StageCategory
    handoffTracker: string | null
    handoffTarget: string | null
  }) => Promise<boolean>
}) => {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(PRESETS[0])
  const [category, setCategory] = useState<StageCategory>('planned')
  const [tracker, setTracker] = useState('')
  const [target, setTarget] = useState('')
  const [handoffError, setHandoffError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const add = async () => {
    if (!name.trim() || pending) return
    const handoff = parseHandoffDraft(tracker, target)
    if (!handoff.ok) return setHandoffError(handoff.error)
    setHandoffError(null)
    setPending(true)
    const ok = await onAdd({
      name: name.trim(),
      color,
      category,
      handoffTracker: handoff.tracker,
      handoffTarget: handoff.target,
    })
    setPending(false)
    if (ok) {
      setName('')
      setTracker('')
      setTarget('')
      const at = PRESETS.findIndex((c) => c === color)
      setColor(PRESETS[(at + 1) % PRESETS.length]!)
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
        className="min-w-[10rem] flex-1"
      />
      {withHandoff ? (
        <HandoffInputs
          tracker={tracker}
          target={target}
          onTracker={setTracker}
          onTarget={setTarget}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
      ) : null}
      {withCategory ? (
        <Select
          size="sm"
          value={category}
          onChange={(e) => setCategory(e.target.value as StageCategory)}
          aria-label="Category"
        >
          {STAGE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </Select>
      ) : null}
      <Button size="sm" variant="primary" onClick={() => void add()} disabled={!name.trim() || pending}>
        {pending ? <Spinner /> : <><Plus size={13} aria-hidden /> Add</>}
      </Button>
      {handoffError ? <p className="text-danger enter-rise w-full text-aux">{handoffError}</p> : null}
    </div>
  )
}

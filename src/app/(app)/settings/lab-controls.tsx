'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button, InlineInput } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { CATEGORY_LABEL } from '@/components/lab/stage'
import { STAGE_CATEGORIES, type StageCategory } from '@/lib/lab/types'
import { LAB_PRESETS as PRESETS, normaliseCairnKey } from '@/lib/lab/ui-colours'
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

/** The add row shared by stages, tags and projects. */
export const AddRow = ({
  placeholder,
  withCategory,
  withCairnKey,
  onAdd,
}: {
  placeholder: string
  withCategory?: boolean
  /** An optional Cairn project key beside the name (lab projects). */
  withCairnKey?: boolean
  onAdd: (input: { name: string; color: string; category: StageCategory; cairnKey: string | null }) => Promise<boolean>
}) => {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(PRESETS[0])
  const [category, setCategory] = useState<StageCategory>('planned')
  const [cairnKey, setCairnKey] = useState('')
  const [pending, setPending] = useState(false)

  const add = async () => {
    if (!name.trim() || pending) return
    setPending(true)
    const ok = await onAdd({ name: name.trim(), color, category, cairnKey: normaliseCairnKey(cairnKey) })
    setPending(false)
    if (ok) {
      setName('')
      setCairnKey('')
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
        className="h-[1.75rem] min-w-[10rem] flex-1"
      />
      {withCairnKey ? (
        <InlineInput
          value={cairnKey}
          onChange={(e) => setCairnKey(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
          placeholder="Cairn key"
          aria-label="Cairn project key (optional)"
          title="The Cairn project that receives this project's todos on croft push. Optional."
          maxLength={10}
          spellCheck={false}
          className="h-[1.75rem] w-[6.5rem] font-mono text-[0.75rem] uppercase"
        />
      ) : null}
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


'use client'

import { useEffect, useRef, useState } from 'react'
import { Select } from '@/components/ui/control'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'
import { TASK_PRIORITIES, TASK_TYPES } from '@/schemas/task'
import {
  GROUP_BY_VALUES,
  SWIMLANE_VALUES,
  UNASSIGNED,
  capitalize,
  type BoardFilters,
  type GroupBy,
  type Swimlane,
} from '@/lib/board-state'
import type { BoardProject } from '@/lib/board-data'
import type { LabProject } from '@/lib/lab/types'
import { LAB_LANES, type LabBoardView, type LabLane } from './lab-lanes'

const GROUP_BY_LABEL: Record<GroupBy, string> = {
  status: 'Status',
  priority: 'Priority',
  type: 'Type',
  project: 'Project',
  agent: 'Agent',
  assignee: 'Assignee',
}

const LAB_LANE_LABEL: Record<LabLane, string> = {
  subject: 'Subject',
  labProject: 'Lab project',
}

const SWIMLANE_LABEL: Record<Swimlane, string> = {
  none: 'None',
  project: 'Project',
  priority: 'Priority',
  agent: 'Agent',
  assignee: 'Assignee',
}

/**
 * A multi-select popover. The same outside-click/Escape pattern as
 * `label-editor.tsx` — one look for every menu in the app.
 */
const FilterMenu = ({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: { value: string; label: string }[]
  selected: string[]
  onChange: (next: string[]) => void
}) => {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Filter by ${label}`}
        className={cn(
          'flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2 text-aux',
          'transition-[color,background-color,border-color] duration-[var(--dur-1)] ease-[var(--ease-out)]',
          selected.length > 0
            ? 'border-accent/70 text-accent bg-accent-subtle'
            : 'border-border text-fg-muted hover:bg-surface-hover hover:text-fg hover:border-border-strong',
        )}
      >
        {label}
        {selected.length > 0 && <span className="tabular">{selected.length}</span>}
      </button>

      {open && (
        <div
          role="menu"
          className="border-border bg-surface pop absolute top-[2rem] left-0 z-50 max-h-[15rem] w-[12.5rem] overflow-y-auto rounded-lg border py-1 raised"
          style={{ '--origin': 'top left' } as React.CSSProperties}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemcheckbox"
              aria-checked={selected.includes(o.value)}
              onClick={() => toggle(o.value)}
              className="hover:bg-surface-hover flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-[var(--dur-1)]"
            >
              <input
                type="checkbox"
                readOnly
                tabIndex={-1}
                checked={selected.includes(o.value)}
                
              />
              <span className="text-fg-muted min-w-0 truncate text-aux">{o.label}</span>
            </button>
          ))}
          {options.length === 0 && <EmptyState compact title="Nothing to filter by yet." />}
        </div>
      )}
    </div>
  )
}

export const BoardToolbar = ({
  filters,
  onChange,
  lab,
  onViewChange,
  projects,
  labProjects,
  subjectOptions,
  agentOptions,
  assigneeOptions,
}: {
  filters: BoardFilters
  onChange: (next: BoardFilters) => void
  /** The lab's filters and lanes, which ride in the same URL. */
  lab: LabBoardView
  onViewChange: (filters: BoardFilters, lab: LabBoardView) => void
  projects: BoardProject[]
  labProjects: Pick<LabProject, 'id' | 'name' | 'color'>[]
  subjectOptions: { value: string; label: string }[]
  agentOptions: string[]
  assigneeOptions: { value: string; label: string }[]
}) => {
  const [knownLabels, setKnownLabels] = useState<string[]>([])

  // One-shot fetch: offering labels already in use is
  // what keeps the filter useful instead of a blank text box.
  useEffect(() => {
    const load = async () => {
      const res = await fetch('/api/v1/labels')
      if (!res.ok) return
      const json = await res.json().catch(() => null)
      setKnownLabels(((json?.data ?? []) as { label: string }[]).map((l) => l.label))
    }
    void load()
  }, [])

  const agentFilterOptions = [
    { value: UNASSIGNED, label: 'Unclaimed' },
    ...agentOptions.map((a) => ({ value: a, label: a })),
  ]

  return (
    // No overflow utility on this row, ever — see board-toolbar.test.ts. Setting one overflow axis to `auto` forces the
    // other from `visible` to `auto`, which is exactly what clipped a floating
    // bar's own menus out of existence. This row wraps instead.
    <div className="border-border flex flex-wrap items-center gap-1 border-b px-3 py-1.5">
      <Select
        size="sm"
        value={filters.groupBy}
        onChange={(e) => onChange({ ...filters, groupBy: e.target.value as GroupBy })}
        aria-label="Group columns by"
      >
        {GROUP_BY_VALUES.map((g) => (
          <option key={g} value={g}>
            Group: {GROUP_BY_LABEL[g]}
          </option>
        ))}
      </Select>

      {/* One control for both kinds of lane: the board's own, and the lab's
          (by subject, by lab project), which live in their own params. */}
      <Select
        size="sm"
        value={lab.lane ?? filters.swimlane}
        onChange={(e) => {
          const value = e.target.value
          if ((LAB_LANES as readonly string[]).includes(value)) {
            onViewChange({ ...filters, swimlane: 'none' }, { ...lab, lane: value as LabLane })
          } else {
            onViewChange({ ...filters, swimlane: value as Swimlane }, { ...lab, lane: null })
          }
        }}
        aria-label="Swimlanes"
      >
        {SWIMLANE_VALUES.filter((s) => s === 'none' || s !== filters.groupBy).map((s) => (
          <option key={s} value={s}>
            Lanes: {SWIMLANE_LABEL[s]}
          </option>
        ))}
        {LAB_LANES.map((l) => (
          <option key={l} value={l}>
            Lanes: {LAB_LANE_LABEL[l]}
          </option>
        ))}
      </Select>

      <span className="bg-border mx-0.5 h-[1rem] w-px shrink-0" aria-hidden />

      <FilterMenu
        label="Lab project"
        options={[
          ...labProjects.map((p) => ({ value: p.name, label: p.name })),
          { value: 'none', label: 'No project' },
        ]}
        selected={lab.labProjects}
        onChange={(v) => onViewChange(filters, { ...lab, labProjects: v })}
      />
      <FilterMenu
        label="Subject"
        options={subjectOptions}
        selected={lab.subjects}
        onChange={(v) => onViewChange(filters, { ...lab, subjects: v })}
      />
      {/* In a lab every todo is filed in the one task project; the filter
          only means something on a board that spans several. */}
      {projects.length > 1 || filters.projects.length > 0 ? (
        <FilterMenu
          label="Project"
          options={projects.map((p) => ({ value: p.key, label: p.title }))}
          selected={filters.projects}
          onChange={(v) => onChange({ ...filters, projects: v })}
        />
      ) : null}
      <FilterMenu
        label="Type"
        options={TASK_TYPES.map((t) => ({ value: t, label: capitalize(t) }))}
        selected={filters.types}
        onChange={(v) => onChange({ ...filters, types: v })}
      />
      <FilterMenu
        label="Priority"
        options={TASK_PRIORITIES.map((p) => ({ value: p, label: capitalize(p) }))}
        selected={filters.priorities}
        onChange={(v) => onChange({ ...filters, priorities: v })}
      />
      <FilterMenu
        label="Label"
        options={knownLabels.map((l) => ({ value: l, label: l }))}
        selected={filters.labels}
        onChange={(v) => onChange({ ...filters, labels: v })}
      />
      <FilterMenu
        label="Agent"
        options={agentFilterOptions}
        selected={filters.agents}
        onChange={(v) => onChange({ ...filters, agents: v })}
      />
      <FilterMenu
        label="Assignee"
        options={assigneeOptions}
        selected={filters.assignees}
        onChange={(v) => onChange({ ...filters, assignees: v })}
      />
    </div>
  )
}

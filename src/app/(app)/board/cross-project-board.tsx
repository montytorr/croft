'use client'

import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowUpRight, ChevronRight } from 'lucide-react'
import { ResolutionDialog } from '../projects/[key]/resolution-dialog'
import { useMutate } from '@/lib/api/use-mutate'
import { BoardToolbar } from './board-toolbar'
import { TodoCard } from './todo-card'
import { ProjectDot } from '../todos/todo-bits'
import {
  labLaneValue,
  labLanesFor,
  matchesLabView,
  parseLabView,
  withLabParams,
  type LabBoardTask,
  type LabBoardView,
} from './lab-lanes'
import { COLUMN_PANEL, COLUMN_WIDTH, ColumnCount, DragPreview, DropList, laneTone } from '@/components/board-columns'
import { EmptyState } from '@/components/empty-state'
import { cn } from '@/lib/utils'
import { Avatar, PriorityIcon, ProjectIcon, StatusIcon, TypePill, projectColor } from '@/components/icons'
import { isTerminal, type ResolutionKind, type TaskPriority, type TaskStatus, type TaskType } from '@/schemas/task'
import type { BoardProject } from '@/lib/board-data'
import type { LabProject } from '@/lib/lab/types'
import {
  SEP,
  UNASSIGNED,
  applyGroupValue,
  buildBoardUrl,
  columnsFor,
  groupValue,
  laneValueOf,
  lanesFor,
  matchesFilters,
  parseFilters,
  type BoardFilters,
  type ColumnDef,
  type GroupBy,
} from '@/lib/board-state'

const ColumnHeading = ({ groupBy, col }: { groupBy: GroupBy; col: ColumnDef }) => {
  if (groupBy === 'type') return <TypePill type={col.value as TaskType} />

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {groupBy === 'status' && <StatusIcon status={col.value as TaskStatus} size={13} />}
      {groupBy === 'priority' && <PriorityIcon priority={col.value as TaskPriority} />}
      {groupBy === 'project' && <ProjectIcon size={13} projectKey={col.value} />}
      {groupBy === 'agent' &&
        (col.value === UNASSIGNED ? (
          <span className="border-border size-[0.875rem] shrink-0 rounded-full border border-dashed" />
        ) : (
          <Avatar name={col.value} size={14} />
        ))}
      {groupBy === 'assignee' && <Avatar name={col.label} size={14} />}
      <span className="truncate text-xs font-medium">{col.label}</span>
    </span>
  )
}

/** The colour a column's hairline takes: whatever its heading is drawn in. */
const columnTone = (groupBy: GroupBy, value: string) => {
  if (groupBy === 'status') return `var(--status-${value})`
  if (groupBy === 'priority') return `var(--priority-${value})`
  if (groupBy === 'type') return `var(--type-${value})`
  if (groupBy === 'project') return projectColor(value)
  return undefined
}

/** A lane: the board's own (a ColumnDef), or the lab's, which carries a subject's ref and colour. */
type BoardLane = ColumnDef & { color?: string | null; ref?: string; href?: string }

const CardList = ({
  dropId,
  tasks,
  className,
  showSubject,
  showProjectBadge,
}: {
  dropId: string
  tasks: LabBoardTask[]
  className?: string
  showSubject: boolean
  showProjectBadge: boolean
}) => (
  <DropList dropId={dropId} count={tasks.length} className={className}>
    {tasks.map((task) => (
      <TodoCard key={task.id} task={task} showProjectBadge={showProjectBadge} showSubject={showSubject} />
    ))}
  </DropList>
)

const ColumnHeader = ({ groupBy, col, count }: { groupBy: GroupBy; col: ColumnDef; count: number }) => (
  <div className="flex h-[1.875rem] items-center gap-2 px-2.5">
    <ColumnHeading groupBy={groupBy} col={col} />
    <ColumnCount count={count} />
  </div>
)

/** No swimlanes: every column is as tall as the board and scrolls on its own. */
const FlatBoard = ({
  groupBy,
  columns,
  tasks,
  showProjectBadge,
}: {
  groupBy: GroupBy
  columns: ColumnDef[]
  tasks: LabBoardTask[]
  showProjectBadge: boolean
}) => (
  <div className="flex h-full w-max gap-2 p-2.5 md:p-3">
    {columns.map((col) => {
      const cards = tasks.filter((t) => groupValue(t, groupBy) === col.value)
      return (
        <section
          key={col.value}
          className={cn(COLUMN_PANEL, 'h-full', COLUMN_WIDTH)}
          style={laneTone(columnTone(groupBy, col.value))}
        >
          <ColumnHeader groupBy={groupBy} col={col} count={cards.length} />
          <CardList
            dropId={`all${SEP}${col.value}`}
            tasks={cards}
            className="min-h-0 flex-1 overscroll-contain"
            showSubject
            showProjectBadge={showProjectBadge}
          />
        </section>
      )
    })}
  </div>
)

const LaneName = ({ lane }: { lane: BoardLane }) =>
  lane.ref ? (
    <>
      <ProjectDot color={lane.color} />
      <span className="text-fg-subtle font-mono text-[0.6875rem]">{lane.ref}</span>
      <span className="text-fg max-w-[40ch] truncate">{lane.label}</span>
    </>
  ) : (
    <>
      {lane.color !== undefined ? <ProjectDot color={lane.color} /> : null}
      <span className="max-w-[40ch] truncate">{lane.label}</span>
    </>
  )

const Lane = ({
  lane,
  groupBy,
  columns,
  tasks,
  showSubject,
  showProjectBadge,
}: {
  lane: BoardLane
  groupBy: GroupBy
  columns: ColumnDef[]
  tasks: LabBoardTask[]
  showSubject: boolean
  showProjectBadge: boolean
}) => {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <section>
      {/* Sticky on the left so the lane stays named while the board is
          scrolled sideways past its first columns. */}
      <div className="sticky left-3 mb-1 flex w-fit max-w-[calc(100vw-2rem)] items-center gap-1">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="text-fg-muted hover:text-fg flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-[0.75rem] font-medium transition-colors duration-[var(--dur-1)]"
        >
          <ChevronRight
            size={13}
            className={cn('shrink-0 transition-transform duration-[var(--dur-2)] ease-[var(--ease-out)]', !collapsed && 'rotate-90')}
          />
          <LaneName lane={lane} />
          <span className="text-fg-subtle tabular rounded-full bg-[color-mix(in_oklab,var(--fg)_6%,transparent)] px-1.5 text-[0.6875rem] leading-[1.125rem]">
            {tasks.length}
          </span>
        </button>
        {lane.href ? (
          <Link
            href={lane.href}
            aria-label={`Open ${lane.ref}`}
            title={`Open ${lane.ref}`}
            className="text-fg-subtle hover:text-accent hover:bg-surface-hover grid size-[1.25rem] shrink-0 place-items-center rounded transition-colors"
          >
            <ArrowUpRight size={12} aria-hidden />
          </Link>
        ) : null}
      </div>

      {!collapsed && (
        <div className="flex gap-2">
          {columns.map((col) => (
            <div
              key={col.value}
              className={cn(COLUMN_PANEL, COLUMN_WIDTH)}
            >
              <CardList
                dropId={`${lane.value}${SEP}${col.value}`}
                tasks={tasks.filter((t) => groupValue(t, groupBy) === col.value)}
                className="max-h-[min(26rem,55dvh)] flex-1"
                showSubject={showSubject}
                showProjectBadge={showProjectBadge}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * Swimlanes cannot each be as tall as the viewport, so a cell is capped and
 * scrolls on its own while the board scrolls down through the lanes. The
 * column headings are drawn once and stick to the top instead of repeating
 * in every lane.
 */
const LaneBoard = ({
  groupBy,
  columns,
  lanes,
  laneOf,
  tasks,
  showSubject,
  showProjectBadge,
}: {
  groupBy: GroupBy
  columns: ColumnDef[]
  lanes: BoardLane[]
  laneOf: (task: LabBoardTask) => string
  tasks: LabBoardTask[]
  showSubject: boolean
  showProjectBadge: boolean
}) => (
  <div className="w-max min-w-full pb-3">
    <div className="bg-bg sticky top-0 z-10 flex gap-2 px-3 pt-3 pb-2">
      {columns.map((col) => (
        <div
          key={col.value}
          className={cn(COLUMN_PANEL, COLUMN_WIDTH)}
          style={laneTone(columnTone(groupBy, col.value))}
        >
          <ColumnHeader
            groupBy={groupBy}
            col={col}
            count={tasks.filter((t) => groupValue(t, groupBy) === col.value).length}
          />
        </div>
      ))}
    </div>
    <div className="flex flex-col gap-3 px-3 pt-1">
      {lanes.map((lane) => (
        <Lane
          key={lane.value}
          lane={lane}
          groupBy={groupBy}
          columns={columns}
          tasks={tasks.filter((t) => laneOf(t) === lane.value)}
          showSubject={showSubject}
          showProjectBadge={showProjectBadge}
        />
      ))}
    </div>
  </div>
)

export const CrossProjectBoard = ({
  tasks: initial,
  projects,
  labProjects,
  initialQuery,
}: {
  tasks: LabBoardTask[]
  projects: BoardProject[]
  /** The lab's projects, for the lab-project filter. */
  labProjects: Pick<LabProject, 'id' | 'name' | 'color'>[]
  /** The request's query string, so the server renders the same view the
   * client hydrates: reading `window.location` alone gave the server the
   * default view and a hydration mismatch whenever a link carried a view. */
  initialQuery: string
}) => {
  const router = useRouter()
  const request = useMutate()
  const [tasks, setTasks] = useState(initial)
  // Adjusted during render rather than in an effect (the pattern React's docs
  // recommend for "reset state when a prop changes"): `router.refresh()`
  // re-renders this component with a new `tasks` prop — fresh from the
  // server, e.g. with the renumbering a project move causes — and this is
  // what reconciles the optimistic guess with what actually happened.
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setTasks(initial)
  }

  const [filters, setFiltersState] = useState<BoardFilters>(() => parseFilters(initialQuery))
  const [lab, setLabState] = useState<LabBoardView>(() => parseLabView(initialQuery))
  const [dragging, setDragging] = useState<LabBoardTask | null>(null)
  const [pendingClose, setPendingClose] = useState<{ task: LabBoardTask; value: string } | null>(null)

  const syncUrl = (nextFilters: BoardFilters, nextLab: LabBoardView) => {
    if (typeof window === 'undefined') return
    window.history.replaceState(
      null,
      '',
      withLabParams(buildBoardUrl(window.location.pathname, nextFilters, window.location.search), nextLab),
    )
  }

  const setView = (nextFilters: BoardFilters, nextLab: LabBoardView) => {
    setFiltersState(nextFilters)
    setLabState(nextLab)
    syncUrl(nextFilters, nextLab)
  }
  const setFilters = (next: BoardFilters) => setView(next, lab)

  // A swimlane grouped by the same field the columns already are would just
  // draw a diagonal of one card per cell — redundant rather than useful.
  const effectiveSwimlane = filters.swimlane === filters.groupBy ? 'none' : filters.swimlane

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Arrow keys move the picked-up card; Space/Enter drops it. dnd-kit wires
    // this up automatically once a KeyboardSensor exists — the draggable's
    // own `tabIndex`/`role` (from `useDraggable`'s `attributes`) is already in
    // place on the card, same as the per-project board.
    useSensor(KeyboardSensor),
  )

  const visible = useMemo(
    () => tasks.filter((t) => matchesFilters(t, filters) && matchesLabView(t, lab)),
    [tasks, filters, lab],
  )
  const columns = useMemo(() => columnsFor(filters.groupBy, tasks, projects), [filters.groupBy, tasks, projects])
  const lanes = useMemo<BoardLane[]>(
    () => (lab.lane ? labLanesFor(lab.lane, visible) : lanesFor(effectiveSwimlane, visible, projects)),
    [lab.lane, effectiveSwimlane, visible, projects],
  )
  const subjectOptions = useMemo(() => {
    const seen = new Map<string, { value: string; label: string }>()
    for (const t of tasks) {
      if (t.subject && !seen.has(t.subject.ref)) seen.set(t.subject.ref, { value: t.subject.ref, label: `${t.subject.ref} · ${t.subject.title}` })
    }
    return [
      ...[...seen.values()].sort((a, b) => Number(b.value.slice(2)) - Number(a.value.slice(2))),
      { value: 'none', label: 'No subject' },
    ]
  }, [tasks])
  // Every todo lives in the one task project in a lab; its badge only earns
  // its place on a board that genuinely spans several.
  const showProjectBadge = projects.length > 1
  const agentOptions = useMemo(
    () => [...new Set(tasks.map((t) => t.claimed_by).filter((a): a is string => Boolean(a)))].sort(),
    [tasks],
  )
  const assigneeOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const t of tasks) seen.set(t.assignee_user_id, t.assignee?.name ?? t.assignee_user_id)
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [tasks])

  const persist = async (
    task: LabBoardTask,
    value: string,
    close?: { resolution: string; kind: ResolutionKind; duplicateOf?: string },
  ) => {
    const previous = tasks
    setTasks((current) =>
      current.map((t) => (t.id === task.id ? { ...t, ...applyGroupValue(t, filters.groupBy, value) } : t)),
    )

    const ref = `${task.project_key}-${task.number}`

    // Agent isn't a plain PATCH-able column: claiming and releasing are their
    // own endpoints with concurrency rules (stealing a lease, refusing to
    // steal a live one), and reusing them here is what keeps a drag honest
    // about "held by someone else" rather than silently overwriting it.
    const result =
      filters.groupBy === 'agent'
        ? value === UNASSIGNED
          ? await request(`/api/v1/tasks/${ref}/release`, { method: 'POST' })
          : await request(`/api/v1/tasks/${ref}/claim`, {
              method: 'POST',
              body: { agent: value, setDoing: false },
            })
        : await request(`/api/v1/tasks/${ref}`, {
            method: 'PATCH',
            body: close
              ? {
                  [filters.groupBy]: value,
                  resolution: close.resolution,
                  resolutionKind: close.kind,
                  ...(close.duplicateOf ? { duplicateOf: close.duplicateOf } : {}),
                }
              : { [filters.groupBy]: value },
          })

    // Grouped by agent this is the board's own way of reassigning work, and
    // the claim is refused while the current holder's lease is still live.
    // Rolling the card back without a word made that look like a glitch
    // rather than "someone else is holding this".
    if (!result.ok) {
      setTasks(previous)
      return false
    }
    router.refresh()
    return true
  }

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    setDragging(null)
    if (!over) return

    const task = tasks.find((t) => t.id === active.id)
    // A pushed todo is Cairn's; its card does not pick up, and a keyboard
    // drag that got here anyway writes nothing.
    if (!task || task.cairn_ref) return

    const value = String(over.id).split(SEP)[1]
    if (!value || groupValue(task, filters.groupBy) === value) return

    // Same rule the per-project board enforces: a drag into Done or
    // Cancelled needs a resolution before it can be sent as a PATCH.
    if (filters.groupBy === 'status' && isTerminal(value as TaskStatus) && !task.has_resolution) {
      setPendingClose({ task, value })
      return
    }

    await persist(task, value)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Outside the scroll box and above it: the filter popovers hang below
          this row, over the board, and must never be clipped by it. */}
      <div className="relative z-20 shrink-0">
        <BoardToolbar
          filters={filters}
          onChange={setFilters}
          lab={lab}
          onViewChange={setView}
          projects={projects}
          labProjects={labProjects}
          subjectOptions={subjectOptions}
          agentOptions={agentOptions}
          assigneeOptions={assigneeOptions}
        />
      </div>

      {/* A fixed id: dnd-kit otherwise numbers its aria-describedby from a
          module counter that the server and the client do not share. */}
      <DndContext
        id="cross-project-board"
        sensors={sensors}
        onDragStart={({ active }: DragStartEvent) =>
          setDragging(tasks.find((t) => t.id === active.id) ?? null)
        }
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="min-h-0 flex-1 snap-x scroll-px-3 overflow-auto md:snap-none">
          {visible.length === 0 ? (
            <EmptyState
              title="Nothing matches these filters."
              action={
                <button
                  type="button"
                  onClick={() =>
                    setView(
                      { ...parseFilters(''), groupBy: filters.groupBy, swimlane: filters.swimlane },
                      { labProjects: [], subjects: [], lane: lab.lane },
                    )
                  }
                  className="text-accent text-[0.75rem] hover:underline"
                >
                  Clear filters
                </button>
              }
            />
          ) : !lab.lane && effectiveSwimlane === 'none' ? (
            <FlatBoard groupBy={filters.groupBy} columns={columns} tasks={visible} showProjectBadge={showProjectBadge} />
          ) : (
            <LaneBoard
              groupBy={filters.groupBy}
              columns={columns}
              lanes={lanes}
              laneOf={(t) => (lab.lane ? labLaneValue(t, lab.lane) : laneValueOf(t, effectiveSwimlane))}
              tasks={visible}
              // Inside a subject's lane every card is that subject's.
              showSubject={lab.lane !== 'subject'}
              showProjectBadge={showProjectBadge}
            />
          )}
        </div>

        <DragOverlay>
          {dragging ? (
            <DragPreview title={dragging.title} />
          ) : null}
        </DragOverlay>
      </DndContext>

      {pendingClose && (
        <ResolutionDialog
          taskTitle={pendingClose.task.title}
          status={pendingClose.value as TaskStatus}
          suggestion={pendingClose.task.checkpoint_summary}
          onCancel={() => setPendingClose(null)}
          onConfirm={async (resolution: string, kind, duplicateOf) => {
            const ok = await persist(pendingClose.task, pendingClose.value, { resolution, kind, duplicateOf })
            setPendingClose(null)
            return ok
          }}
        />
      )}
    </div>
  )
}

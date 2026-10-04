import type { BoardTask } from '@/lib/board-data'
import { parseSubjectRef, type LabTodo } from '@/lib/lab/types'

/**
 * The lab's side of `/board`: filtering by lab project and subject, and lanes
 * per subject or per lab project. Layered over `src/lib/board-state.ts` rather
 * than folded into it, so the board's own grouping stays as it was and these
 * params simply ride along in the same URL.
 *
 * `labProject`, not `project`: on the board `project` already filters by the
 * task project a todo is filed in, and shared links carry it.
 */

/** A board card: `listBoardTasks` carries each todo's subject and hand-off. */
export type LabBoardTask = BoardTask

export const LAB_LANES = ['subject', 'labProject'] as const
export type LabLane = (typeof LAB_LANES)[number]

export type LabBoardView = {
  /** Lab project names (any case), `none` for a subject in no project or no subject. */
  labProjects: string[]
  /** Subject refs (`S-4`), `none` for a todo on no subject. */
  subjects: string[]
  /** Lanes by subject or lab project; carried in the same `swimlane` param the board uses. */
  lane: LabLane | null
}

export const EMPTY_LAB_VIEW: LabBoardView = { labProjects: [], subjects: [], lane: null }

/** The lane for "none of these": never a subject ref or a project name. */
export const NO_LANE = '__none__'

const list = (params: URLSearchParams, key: string) =>
  (params.get(key) ?? '').split(',').map((v) => v.trim()).filter(Boolean)

export const parseLabView = (search: string): LabBoardView => {
  const params = new URLSearchParams(search)
  const lane = params.get('swimlane') ?? ''
  return {
    labProjects: list(params, 'labProject'),
    subjects: list(params, 'subject').map((v) => {
      const n = parseSubjectRef(v)
      return n === null ? v : `S-${n}`
    }),
    lane: (LAB_LANES as readonly string[]).includes(lane) ? (lane as LabLane) : null,
  }
}

/**
 * Adds the lab's params to a board URL built by `buildBoardUrl`, which knows
 * only its own and would otherwise drop them. A lab lane replaces whatever
 * `swimlane` it carried (the board's own reads a lab lane as `none`).
 */
export const withLabParams = (url: string, view: LabBoardView): string => {
  const [path, qs = ''] = url.split('?')
  const params = new URLSearchParams(qs)
  params.delete('labProject')
  params.delete('subject')
  if (view.labProjects.length) params.set('labProject', view.labProjects.join(','))
  if (view.subjects.length) params.set('subject', view.subjects.join(','))
  if (view.lane) params.set('swimlane', view.lane)
  const next = params.toString()
  return next ? `${path}?${next}` : path!
}

type WithSubject = { subject: LabTodo['subject'] }

export const matchesLabView = (task: WithSubject, view: LabBoardView): boolean => {
  if (view.labProjects.length) {
    const name = task.subject?.project?.name.toLowerCase()
    const ok = view.labProjects.some((p) => (p.toLowerCase() === 'none' ? !name : p.toLowerCase() === name))
    if (!ok) return false
  }
  if (view.subjects.length) {
    const ok = view.subjects.some((s) =>
      s.toLowerCase() === 'none' ? !task.subject : parseSubjectRef(s) === task.subject?.number,
    )
    if (!ok) return false
  }
  return true
}

export const labLaneValue = (task: WithSubject, lane: LabLane): string =>
  lane === 'subject' ? (task.subject?.ref ?? NO_LANE) : (task.subject?.project?.name ?? NO_LANE)

export type LabLaneDef = {
  value: string
  label: string
  /** The lab project's colour, for the lane's dot. */
  color: string | null
  /** A subject lane's ref and page. */
  ref?: string
  href?: string
}

/**
 * Only lanes with a visible card, like the board's own swimlanes. Subjects
 * group by lab project (by name, none last), newest subject first; the
 * "no subject" / "no project" lane always comes last.
 */
export const labLanesFor = (lane: LabLane, visible: WithSubject[]): LabLaneDef[] => {
  const lanes = new Map<string, LabLaneDef & { project: string | null; number: number }>()
  let none = false
  for (const t of visible) {
    const value = labLaneValue(t, lane)
    if (value === NO_LANE) {
      none = true
      continue
    }
    if (lanes.has(value) || !t.subject) continue
    const project = t.subject.project
    lanes.set(
      value,
      lane === 'subject'
        ? {
            value,
            label: t.subject.title,
            ref: t.subject.ref,
            href: `/subjects/${t.subject.number}`,
            color: project?.color ?? null,
            project: project?.name ?? null,
            number: t.subject.number,
          }
        : { value, label: project!.name, color: project!.color, project: project!.name, number: 0 },
    )
  }
  const sorted = [...lanes.values()].sort((a, b) => {
    if (a.project !== b.project) {
      if (!a.project) return 1
      if (!b.project) return -1
      return a.project.localeCompare(b.project)
    }
    return b.number - a.number
  })
  const defs: LabLaneDef[] = sorted.map(({ project: _p, number: _n, ...def }) => def)
  if (none) defs.push({ value: NO_LANE, label: lane === 'subject' ? 'No subject' : 'No project', color: null })
  return defs
}

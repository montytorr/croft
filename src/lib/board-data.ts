import { admin } from '@/lib/db/client'
import { byTitle } from '@/lib/utils'
import { withAssignees, type Person } from '@/lib/api/people'
import { withHandoff } from '@/lib/api/handoff-shape'
import type { Handoff } from '@/lib/lab/types'
import type { TaskPriority, TaskStatus, TaskType } from '@/schemas/task'
import { withTaskSubjects, type LabTodoSubject } from '@/lib/api/lab-todos'
import { restrictTo, visibleTasksOr, type Viewer } from '@/lib/api/visibility'

/**
 * Data loader for the cross-project board (`/board`, CROFT-72).
 *
 * A deliberate standalone copy of the projection `listTasks`/`listAllTasks`
 * use in `src/lib/data.ts`, not an import from it: that file is being edited
 * concurrently, and a shape change made for the per-project views should not
 * silently ripple into this one (or vice versa).
 */

export type BoardTask = {
  id: string
  number: number
  title: string
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  labels: string[]
  due_date: string | null
  position: number
  assignee_user_id: string
  /** Named live off `assignee_user_id`, not stored — see `withAssignees`. */
  assignee: Person | null
  claimed_by: string | null
  heartbeat_at: string | null
  blocked_reason: string | null
  updated_at: string
  preview: string | null
  external_ref: string | null
  resolution_kind: string | null
  has_resolution: boolean
  checkpoint_summary: string | null
  /** The project this task actually lives in — the whole point of this board. */
  project_key: string
  /** The project the task lives in, as a one-element list (what the board filters read). */
  project_keys: string[]
  /** The subject a todo belongs to (ref, title, lab project). Null on an ordinary task. */
  subject: LabTodoSubject | null
  /** The task a todo was handed off to in another tracker, and what that tracker last said about it. */
  handoff: Handoff | null
}

export type BoardProject = { id: string; key: string; title: string }

const BOARD_COLUMNS =
  'id, number, title, type, status, priority, labels, due_date, position, ' +
  'assignee_user_id, claimed_by, heartbeat_at, blocked_reason, external_ref, updated_at, ' +
  'resolution_kind, has_resolution, checkpoint_summary, handoff_tracker, handoff_ref, handoff_url, handoff_status, handoff_synced_at, ' +
  'preview:description'

const PREVIEW_CHARS = 280

/**
 * Every task across every active project in the shared workspace, plus the project
 * list itself (columns and filters need it even for projects with nothing
 * currently showing). Closed tasks are excluded by default, same convention
 * as the per-project board.
 */
export const listBoardTasks = async (
  _userId: string,
  { includeClosed = false, limit = 2000 }: { includeClosed?: boolean; limit?: number },
  viewer: Viewer,
): Promise<{ tasks: BoardTask[]; projects: BoardProject[]; closedHidden: number }> => {
  const closed = ['done', 'cancelled']
  // Tasks and the closed count hold only what `viewer` may see: a todo of
  // somebody else's private subject is not on the board, nor in its numbers.
  const visible = await visibleTasksOr(viewer.id)

  const [projectsRes, tasksRes, totals] = await Promise.all([
    admin()
      .from('projects')
      .select('id, key, title')
      .eq('status', 'active')
      .order('title')
      .order('created_at'),
    (() => {
      let q = restrictTo(admin().from('tasks').select(`${BOARD_COLUMNS}, project:projects!project_id!inner(key)`), visible)
      if (!includeClosed) q = q.not('status', 'in', `(${closed.join(',')})`)
      return q.order('updated_at', { ascending: false }).limit(limit)
    })(),
    restrictTo(admin().from('tasks').select('id', { count: 'exact', head: true }), visible).in('status', closed),
  ])

  type Row = Omit<BoardTask, 'project_key' | 'assignee' | 'subject' | 'handoff'> & { project: { key: string } | { key: string }[] }

  const tasks = await withTaskSubjects(
    await withAssignees(
    ((tasksRes.data ?? []) as unknown as Row[]).map((t) => {
      const home = (Array.isArray(t.project) ? t.project[0]?.key : t.project?.key) ?? ''
      return {
        ...(withHandoff(t) as unknown as Omit<Row, 'project'> & Pick<BoardTask, 'handoff'>),
        preview: t.preview ? t.preview.slice(0, PREVIEW_CHARS) : null,
        project_key: home,
        project_keys: [home].filter(Boolean),
      }
    }),
    ),
    viewer.id,
  )

  return {
    tasks,
    projects: ((projectsRes.data ?? []) as BoardProject[]).sort(byTitle),
    closedHidden: includeClosed ? 0 : (totals.count ?? 0),
  }
}

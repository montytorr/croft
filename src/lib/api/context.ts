import { admin } from '@/lib/db/client'
import type { Actor } from './auth'
import { projectForCheckoutName, projectForRepo } from './project-resolution'
import { formerKeysByProject, formerRefsOf, liveProjectKey, resolveProject, type FormerKey, type KeyRename } from './project-keys'
import { peopleByIds } from './people'
import { TASK_PRIORITIES } from '@/schemas/task'
import { restrictTo, visibleTasksOr } from './visibility'

/**
 * The briefing a session opens with.
 *
 * The store this replaces injected 12.2 KB into every session: fifty
 * observation one-liners, ten session summaries and five full narratives, on
 * the theory that more context is better context. It was consulted 103 times
 * in seventeen days.
 *
 * This is the opposite bet. Only things that require the reader to act or that
 * change what they would do next: what you are still holding, what is in
 * flight around you, and which claims nobody is acting on. Titles and refs,
 * never bodies — same contract as `croft check`.
 */

/** Matches the claim lease in the claim route. A claim older than this is takeable. */
const LEASE_MINUTES = 15

/** Past this with no note, a held task is a hold nobody is acting on. */
const QUIET_HOURS = 24

/**
 * How many of the caller's unattended tasks the briefing names. The rest are a
 * count: this is read at the top of every session, and a backlog is not news.
 */
const UNATTENDED_SHOWN = 5
/** How many are read to rank and count them; a count past this is a floor. */
const UNATTENDED_READ = 100

export type ContextPayload = {
  project: string | null
  /**
   * Set when the project asked for is a key it used to have — typically a
   * checkout mapped before the rename. The briefing answers for the live
   * project and says so, instead of briefing on nothing (CROFT-264).
   */
  projectRenamed?: KeyRename
  held: {
    ref: string
    title: string
    status: string
    claimedAt: string | null
    lastNoteAt: string | null
    quiet: boolean
    /**
     * The refs this task had before a RECENT rename of its project, so an
     * agent that wrote AC-113 in its notes yesterday recognises HOL-113 today.
     * Only keys retired after the task existed, and only within
     * RECENT_RENAME_DAYS — past that the old ref is history, not news.
     */
    was?: string[]
  }[]
  inFlight: {
    ref: string
    title: string
    status: string
    claimedBy: string | null
    /** How long since anything happened on it, for the reader to judge. */
    quietFor: string
    /**
     * In progress, nobody on it, and quiet long enough that it is not being
     * worked on. Work that was started and dropped is the easiest thing in
     * the tracker to lose: it is not in anyone's held list and not a stale
     * claim either, so nothing surfaces it again.
     */
    stalled: boolean
    /**
     * Whose it is — set ONLY when that is not the caller's human (CROFT-310).
     * Absent means the caller's own, or that it cannot be told; the briefing
     * names an owner only when picking the task up would be taking someone
     * else's work.
     */
    assignee?: string
  }[]
  /**
   * The caller's human's open work in this project that nobody is on: no
   * claim, or one past its lease. Most urgent first, then most recently
   * touched; `more` is how many were left out. Tasks already listed in
   * `inFlight` or `held` are not repeated here.
   */
  unattended: {
    tasks: { ref: string; title: string; status: string; priority: string }[]
    more: number
  }
  staleClaims: { ref: string; title: string; claimedBy: string; heldFor: string }[]
}

const TASK_SELECT =
  'id, number, title, status, claimed_by, claimed_at, heartbeat_at, updated_at, ' +
  'project:projects!project_id!inner(key)'

/** In-flight and unattended rows also say whose they are. */
const OWNED_SELECT = `${TASK_SELECT}, priority, assignee_user_id`

/** Held tasks also carry what a recent rename is measured against. */
const HELD_SELECT = `${TASK_SELECT}, project_id, created_at`

export class ContextScopeError extends Error {
  constructor() { super('project scope requires a resolved project') }
}

export class ContextProjectNotFoundError extends Error {
  constructor() { super('Project not found') }
}

/** How long a key change stays worth mentioning beside a held ref. */
export const RECENT_RENAME_DAYS = 30

/**
 * The former refs worth showing beside a held task: keys retired after the
 * task was created (earlier ones never named it) and within the window.
 */
export const recentFormerRefs = (
  task: { number: number; created_at?: string | null },
  formerKeys: Pick<FormerKey, 'key' | 'retired_at'>[],
  now = Date.now(),
): string[] =>
  formerRefsOf(
    task,
    formerKeys.filter(
      (former) => now - Date.parse(former.retired_at) <= RECENT_RENAME_DAYS * 86_400_000,
    ),
  )

type TaskRow = {
  id: string
  number: number
  title: string
  status: string
  claimed_by: string | null
  claimed_at: string | null
  heartbeat_at: string | null
  updated_at: string | null
  project: { key: string }
}

type OwnedRow = TaskRow & { priority: string; assignee_user_id: string | null }

const refOf = (t: TaskRow) => `${t.project.key}-${t.number}`

const priorityRank = (priority: string) => {
  const index = (TASK_PRIORITIES as readonly string[]).indexOf(priority)
  return index === -1 ? TASK_PRIORITIES.length : index
}

const humanDuration = (fromIso: string | null): string => {
  if (!fromIso) return 'unknown'
  const minutes = Math.round((Date.now() - new Date(fromIso).getTime()) / 60_000)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export const buildContext = async (
  actor: Actor,
  input: { cwd?: string; project?: string; repo?: string; scope?: 'all' | 'project' },
): Promise<ContextPayload> => {
  // A key given explicitly may be one the project no longer has — every
  // checkout mapped before a rename sends it — so it is resolved to the live
  // key rather than matched as a string that no row carries any more.
  const resolved = input.scope === 'project' && input.project
    ? await resolveProject(input.project)
    : null
  if (input.scope === 'project' && input.project && !resolved) throw new ContextProjectNotFoundError()
  const asked = input.project
    ? resolved ? { key: resolved.project.key, renamed: resolved.renamed } : await liveProjectKey(input.project)
    : null
  const project =
    asked?.key ??
    (input.repo ? await projectForRepo(actor.userId, input.repo) : null) ??
    (input.cwd ? await projectForCheckoutName(actor.userId, input.cwd) : null)
  const scopedProject = input.scope === 'project' ? project : null
  if (input.scope === 'project' && !scopedProject) throw new ContextScopeError()

  // Every list below holds only tasks the caller's human may see: a todo of
  // somebody else's private subject is neither named nor counted (v0.4).
  const visible = await visibleTasksOr(actor.userId)

  // --- what this agent is still holding ---------------------------------
  const held: ContextPayload['held'] = []
  if (actor.actorId) {
    let query = restrictTo(admin().from('tasks').select(HELD_SELECT), visible)
      .eq('claimed_by', actor.actorId)
    if (scopedProject) query = query.eq('projects.key', scopedProject)
    const { data, error } = await query
      .order('claimed_at', { ascending: true })
      .limit(10)
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as unknown as (TaskRow & { project_id: string; created_at: string | null })[]
    const [lastNotes, formerKeys] = await Promise.all([
      lastNoteTimes(rows.map((r) => r.id)),
      formerKeysByProject([...new Set(rows.map((r) => r.project_id))]),
    ])

    for (const row of rows) {
      const lastNoteAt = lastNotes.get(row.id) ?? null
      const since = lastNoteAt ?? row.claimed_at
      const quiet = Boolean(
        since && Date.now() - new Date(since).getTime() > QUIET_HOURS * 3_600_000,
      )
      const was = recentFormerRefs(row, formerKeys.get(row.project_id) ?? [])
      held.push({
        ref: refOf(row),
        title: row.title,
        status: row.status,
        claimedAt: row.claimed_at,
        lastNoteAt,
        quiet,
        ...(was.length > 0 ? { was } : {}),
      })
    }
  }

  // --- what else is in flight here, and what of yours nobody is on -----
  let inFlight: ContextPayload['inFlight'] = []
  let unattended: ContextPayload['unattended'] = { tasks: [], more: 0 }
  if (project) {
    // Read together: this route is on the path of every session start.
    const [flight, owned] = await Promise.all([
      restrictTo(admin().from('tasks').select(OWNED_SELECT), visible)
        .eq('projects.key', project)
        .in('status', ['doing', 'in-review'])
        .order('updated_at', { ascending: false })
        .limit(8),
      restrictTo(admin().from('tasks').select(OWNED_SELECT), visible)
        .eq('projects.key', project)
        .eq('assignee_user_id', actor.userId)
        .in('status', ['todo', 'backlog', 'doing'])
        .order('updated_at', { ascending: false })
        .limit(UNATTENDED_READ),
    ])
    if (flight.error) throw new Error(flight.error.message)
    if (owned.error) throw new Error(owned.error.message)

    const flightRows = (flight.data ?? []) as unknown as OwnedRow[]
    // Names are looked up only for somebody else's work, which is the only
    // work the briefing names an owner for — usually none, so usually no query.
    const others = flightRows
      .map((row) => row.assignee_user_id)
      .filter((id): id is string => Boolean(id) && id !== actor.userId)
    const people = others.length > 0 ? await peopleByIds(others) : new Map<string, { name: string }>()

    inFlight = flightRows.map((row) => {
      const quietSince = row.heartbeat_at ?? row.updated_at
      const quietMs = quietSince ? Date.now() - new Date(quietSince).getTime() : 0
      const owner = row.assignee_user_id && row.assignee_user_id !== actor.userId
        ? people.get(row.assignee_user_id)?.name
        : undefined
      return {
        ref: refOf(row),
        title: row.title,
        status: row.status,
        claimedBy: row.claimed_by,
        quietFor: humanDuration(quietSince),
        stalled: !row.claimed_by && quietMs > QUIET_HOURS * 3_600_000,
        ...(owner ? { assignee: owner } : {}),
      }
    })

    // Nobody on it: no claim, or a claim past its lease — the same test the
    // stale-claim list uses, so a claim with no heartbeat yet is still live.
    // The caller's own claims are its held list, and in-flight rows are
    // already on screen; saying either twice spends the budget on repetition.
    const leaseCutoff = Date.now() - LEASE_MINUTES * 60_000
    const shown = new Set([...inFlight.map((t) => t.ref), ...held.map((t) => t.ref)])
    const idle = ((owned.data ?? []) as unknown as OwnedRow[])
      .filter((row) =>
        !row.claimed_by ||
        (row.claimed_by !== actor.actorId &&
          Boolean(row.heartbeat_at) &&
          Date.parse(row.heartbeat_at ?? '') < leaseCutoff))
      .filter((row) => !shown.has(refOf(row)))
      // Stable, so recency (the query's order) breaks a priority tie.
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    unattended = {
      tasks: idle.slice(0, UNATTENDED_SHOWN).map((row) => ({
        ref: refOf(row),
        title: row.title,
        status: row.status,
        priority: row.priority,
      })),
      more: Math.max(0, idle.length - UNATTENDED_SHOWN),
    }
  }

  // --- claims nobody is acting on ---------------------------------------
  const cutoff = new Date(Date.now() - LEASE_MINUTES * 60_000).toISOString()
  let staleQuery = restrictTo(admin().from('tasks').select(TASK_SELECT), visible)
    .not('claimed_by', 'is', null)
    .lt('heartbeat_at', cutoff)
  if (scopedProject) staleQuery = staleQuery.eq('projects.key', scopedProject)
  const { data: staleData, error: staleError } = await staleQuery
    .order('heartbeat_at', { ascending: true })
    .limit(5)
  if (staleError) throw new Error(staleError.message)

  const staleClaims = ((staleData ?? []) as unknown as TaskRow[]).map((row) => ({
    ref: refOf(row),
    title: row.title,
    claimedBy: row.claimed_by ?? 'unknown',
    heldFor: humanDuration(row.claimed_at),
  }))

  return {
    project,
    ...(asked?.renamed ? { projectRenamed: asked.renamed } : {}),
    held,
    inFlight,
    unattended,
    staleClaims,
  }
}

const lastNoteTimes = async (taskIds: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  if (taskIds.length === 0) return out

  const { data, error } = await admin()
    .from('task_notes')
    .select('task_id, created_at')
    .in('task_id', taskIds)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)

  for (const row of data ?? []) {
    const id = row.task_id as string
    if (!out.has(id)) out.set(id, row.created_at as string)
  }
  return out
}

import { TASK_PRIORITIES } from '@/schemas/task'

/**
 * Which task to pick up.
 *
 * The briefing lists what is held, what is in flight and what was dropped, and
 * never says which one to do — so every agent invented its own ranking and
 * they did not agree. The query was never the hard part; the ordering is.
 *
 * Two principles decide almost everything here:
 *
 * 1. **Finishing beats starting.** Work already underway is cheaper to
 *    complete than work that has not begun, and work left with a checkpoint is
 *    cheaper still, because somebody already wrote down where they got to.
 * 2. **Never offer what cannot be worked.** Something blocked, or waiting on a
 *    task that is not done, is not a recommendation — it is a trap that costs
 *    an agent a context window to discover.
 */

/** Lower sorts first. */
const TIERS = [
  'holding',
  'checkpointed',
  'in-review',
  'dropped',
  'todo',
  'backlog',
] as const

export type Tier = (typeof TIERS)[number]

export type Candidate = {
  ref: string
  title: string
  status: string
  priority: string
  type?: string | null
  claimedBy?: string | null
  /**
   * Which session holds it, when the holder could name one.
   *
   * `claimedBy` is an actorLabel — every Claude Code session on a machine
   * writes the same string — so it cannot answer "is this mine". NULL means
   * the holder could not say, never that nobody holds it.
   */
  claimedSession?: string | null
  heartbeatAt?: string | null
  updatedAt?: string | null
  checkpoint?: string | null
  blockedAt?: string | null
  /** Tasks this one waits on that are not finished. */
  unmetDeps?: number
  /** The human the task belongs to (CROFT-310), and their name to show. */
  assigneeId?: string | null
  assignee?: string | null
}

export type Ranked = Candidate & { tier: Tier; reason: string }

const QUIET_MS = 24 * 60 * 60 * 1000

const priorityRank = (priority: string) => {
  const index = (TASK_PRIORITIES as readonly string[]).indexOf(priority)
  return index === -1 ? TASK_PRIORITIES.length : index
}

/**
 * Someone else is on it, and recently enough to believe.
 *
 * A stale claim is not a reason to skip a task — that is exactly the abandoned
 * work this is meant to surface — so the heartbeat, not the claim, decides.
 */
/**
 * This caller holds it — the same worker, not merely the same name.
 *
 * The label matching was not enough, and believing it was the whole bug: four
 * Claude Code sessions share one actorLabel, so a sibling's claim looked like
 * the caller's own. A live one was then not merely un-skipped but RECOMMENDED
 * — "you are holding this one" — which sends a second session into a file the
 * first is editing.
 *
 * Either side being unable to name a session means "cannot tell", and cannot
 * tell falls back to the label. Treating it as "somebody else's" would make
 * every claim made before this existed disappear from `croft next` at once.
 */
const isMine = (task: Candidate, me: string | null, mySession: string | null) =>
  Boolean(task.claimedBy) &&
  task.claimedBy === me &&
  (!mySession || !task.claimedSession || task.claimedSession === mySession)

const heldByAnother = (
  task: Candidate,
  me: string | null,
  now: number,
  mySession: string | null,
) => {
  if (!task.claimedBy) return false
  if (isMine(task, me, mySession)) return false
  const beat = task.heartbeatAt ? Date.parse(task.heartbeatAt) : NaN
  if (Number.isNaN(beat)) return true
  return now - beat < QUIET_MS
}

const tierOf = (
  task: Candidate,
  me: string | null,
  now: number,
  mySession: string | null = null,
): Tier | null => {
  if (task.status === 'done' || task.status === 'cancelled') return null
  if (task.blockedAt) return null
  if ((task.unmetDeps ?? 0) > 0) return null
  if (heldByAnother(task, me, now, mySession)) return null

  // Same test as heldByAnother uses, not a looser one. A STALE claim from
  // another session reaches here — the heartbeat decides whether it is skipped
  // — and comparing the label alone here labelled it "you are holding this",
  // which was the original bug wearing a different hat.
  if (task.status === 'doing' && isMine(task, me, mySession)) return 'holding'
  if (task.status === 'doing') return task.checkpoint ? 'checkpointed' : 'dropped'
  if (task.status === 'in-review') return 'in-review'
  if (task.status === 'todo') return 'todo'
  return 'backlog'
}

/**
 * Somebody else's, as far as anyone can tell. An unknown on either side is
 * not someone else's: a caller with no user, or a task nobody has named an
 * owner for, must rank exactly as it did before assignees existed.
 */
const assignedElsewhere = (task: Candidate, myUserId: string | null) =>
  Boolean(myUserId && task.assigneeId && task.assigneeId !== myUserId)

const REASONS: Record<Tier, string> = {
  holding: 'you are holding this one — finish it or hand it back',
  checkpointed: 'started, then dropped, and whoever left it wrote down where they got to',
  'in-review': 'the work is done and it is waiting on someone to close it out',
  dropped: 'started and left with nothing written down — check it before trusting it',
  todo: 'queued and ready',
  backlog: 'nothing readier is waiting',
}

/**
 * Ranked, best first. Anything unworkable is absent rather than ordered last:
 * a list that ends in things you must not pick is a list that has to be read
 * to the bottom to be used safely.
 *
 * Another person's task is ranked, not dropped: the workspace is shared and
 * picking it up can be right. But inside a tier it comes after the caller's
 * own human's work — ahead of priority, because an urgent task is urgent for
 * whoever owns it — and it says whose it is, so taking it is a choice rather
 * than an accident. Tier still wins: finishing beats starting, whoever's it is.
 */
export const rankNext = (
  tasks: Candidate[],
  {
    me = null,
    now = Date.now(),
    mySession = null,
    myUserId = null,
  }: { me?: string | null; now?: number; mySession?: string | null; myUserId?: string | null } = {},
): Ranked[] =>
  tasks
    .flatMap((task) => {
      const tier = tierOf(task, me, now, mySession)
      if (!tier) return []
      const reason = assignedElsewhere(task, myUserId)
        ? `${REASONS[tier]} · assigned to ${task.assignee ?? 'someone else'}`
        : REASONS[tier]
      return [{ ...task, tier, reason }]
    })
    .sort((a, b) => {
      const byTier = TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)
      if (byTier !== 0) return byTier
      const byOwner = Number(assignedElsewhere(a, myUserId)) - Number(assignedElsewhere(b, myUserId))
      if (byOwner !== 0) return byOwner
      const byPriority = priorityRank(a.priority) - priorityRank(b.priority)
      if (byPriority !== 0) return byPriority
      // Oldest first within a tier, so nothing rots at the bottom for being
      // untouched — the opposite of what "most recently updated" would do.
      return Date.parse(a.updatedAt ?? '') - Date.parse(b.updatedAt ?? '')
    })

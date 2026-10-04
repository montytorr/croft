import { admin } from '@/lib/db/client'
import type { Actor } from './auth'
import { actorLabel } from './actor'
import { CLAIM_LEASE_SECONDS } from '@/lib/utils'
import { isHandedOff } from './handoff-shape'

/**
 * Taking a task, as one conditional UPDATE.
 *
 * Extracted so the claim route and the implicit claim below cannot drift into
 * two different ideas of what holding a task means — the lease window, the
 * attempt counter and the recorded events are the coordination layer, and a
 * second copy of them would be a second answer to "who has this".
 */
/**
 * Whether this claim belongs to a different session than the caller's.
 *
 * Pure and exported for the same reason splitHeldByWorked is: the failure it
 * prevents is silent. Releasing somebody else's claim looked exactly like
 * releasing your own, and the board simply showed the task free afterwards.
 *
 * True only when BOTH sides can name a session. A holder of null means the
 * claim predates this column or came from a runtime with no session to give,
 * and treating "cannot tell" as "not yours" would start refusing releases
 * that have always worked.
 */
export const isAnotherSessionsClaim = (
  holder: string | null | undefined,
  mine: string | null | undefined,
): boolean => Boolean(holder && mine && holder !== mine)

export const takeTask = async (
  actor: Actor,
  task: { id: string; status?: unknown; attempt?: unknown; project_id?: unknown },
  { agent, setDoing = true }: { agent?: string; setDoing?: boolean } = {},
) => {
  const holder = agent
    ? actorLabel('agent', agent, actor.userDisplayName)
    : actor.actorId
  const now = new Date()
  const staleBefore = new Date(now.getTime() - CLAIM_LEASE_SECONDS * 1000).toISOString()

  const { data, error } = await admin().rpc<Record<string, unknown> | null>('claim_task_atomic', {
    p_task_id: task.id,
    p_owner_user_id: actor.userId,
    p_actor_type: actor.actorType,
    p_actor_id: actor.actorId,
    p_holder: holder,
    p_stale_before: staleBefore,
    p_set_doing: setDoing,
  })

  if (error) return { row: null, error: error.message }
  if (!data) return { row: data, error: null }

  /**
   * Which session took it, stamped after the fact and on purpose.
   *
   * The claim itself is one conditional UPDATE and was never the broken part;
   * adding a parameter to claim_task_atomic means dropping and recreating the
   * function every agent depends on, to carry a field that is metadata about
   * the holder rather than part of the decision. So: the lock stays untouched,
   * and the name of the holder is written immediately after it.
   *
   * The window between the two is real and harmless. Losing it leaves
   * claimed_session NULL, which every reader already treats as "cannot tell"
   * and handles exactly as it did before this column existed.
   */
  if (actor.sessionId) {
    await admin()
      .from('tasks')
      .update({ claimed_session: actor.sessionId })
      .eq('id', task.id)
  }

  return { row: { ...(data as Record<string, unknown>), claimed_session: actor.sessionId }, error: null }
}

/**
 * A checkpoint claims the task. A note does not.
 *
 * The first version claimed on any work-log write, to fix a real problem: 36%
 * of closed tasks were never claimed, so they never showed as In Progress
 * while somebody was on them, and no amount of restating the rule had changed
 * that.
 *
 * It was too broad, and an agent reported it against real history. Triaging a
 * backlog, it wrote a `finding` on a task it was only READING; the task went
 * to `doing`; that read as false, so the agent reverted it; minutes later it
 * began actually working and never re-claimed. The task was never `doing`
 * during the only window when it was genuinely being worked — the exact
 * failure the auto-claim existed to prevent, caused by the auto-claim.
 *
 * A note is an annotation, and annotating is most of what reading a backlog
 * is. A checkpoint is not: it says "here is where I got to", which nobody
 * writes about work they are not doing. So the inference moved to the one
 * signal that carries it unambiguously, and `croft note` says plainly when a
 * task is unclaimed instead of quietly deciding for you.
 *
 * Three limits, unchanged:
 *   - agents only. Humans coordinate by talking, and a person leaving a
 *     comment does not mean they have picked the work up.
 *   - never steals. If somebody else holds a live lease this does nothing.
 *   - never reopens. A note on a closed task is a postscript, not a restart.
 *   - never takes a todo handed off to another tracker, whose status is theirs.
 */
export const shouldClaimByWorking = (
  actor: { actorType: string },
  task: Record<string, unknown>,
): boolean => {
  if (actor.actorType !== 'agent') return false
  if (task.claimed_by) return false
  // Working on a todo another tracker owns is not claiming it.
  if (isHandedOff(task)) return false
  const status = task.status as string
  return status !== 'done' && status !== 'cancelled'
}

import { createHash } from 'node:crypto'
import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import type { Handoff } from '@/lib/lab/types'
import { HANDOFF_COLUMNS, type HandoffColumns, handoffOf, isTerminalHandoff, withHandoff, TERMINAL_HANDOFF_STATUSES } from './handoff-shape'
import type { Actor } from './auth'
import { isTerminal, RESOLUTION_KINDS, type TaskStatus } from '@/schemas/task'
import { addSubjectNote } from './subjects'
import { closeTask } from './tasks'

/**
 * The hand-off to another tracker.
 *
 * A todo that turns into committed work is filed in the team's tracker
 * (`croft handoff T-41` creates it there through the machine's own adapter and
 * records the link here). From then on that tracker owns the todo's status:
 * sync reads the task back and, when the tracker closes it, writes the outcome
 * into the subject's log once, so the lab learns how the work it spun off
 * ended without anyone copying it across.
 *
 * Nothing here names a tracker. The tracker is data on the link.
 */

export { TERMINAL_HANDOFF_STATUSES }

/** `LIN-331 done: <resolution>`: the line an ended hand-off leaves in the subject's log. */
export const handoffOutcomeNote = (ref: string, status: string, resolution: string | null | undefined) =>
  `${ref} ${status}${resolution?.trim() ? `: ${resolution.trim()}` : ''}`

/**
 * Keyed on the tracker, the ref and the terminal status, not the text: a
 * resolution revised there afterwards must not add a second "done" line.
 */
export const handoffOutcomeHash = (tracker: string, ref: string, status: string) =>
  createHash('sha256').update(`${tracker}\n${ref}\n${status}`, 'utf8').digest('hex').slice(0, 32)

type OutcomeTodo = {
  id: string
  status: string
  resolution: string | null
  resolution_kind: string | null
  claimed_by: string | null
  subject_id: string | null
}

/** What closing a todo says about the task that ended it. */
export const closedInResolution = (tracker: string, ref: string, resolution: string | null | undefined) =>
  `Closed in ${tracker} as ${ref}${resolution?.trim() ? `: ${resolution.trim()}` : ''}`

/** The tracker's kind when it is one Croft has; `verified` otherwise, since the lab checked its answer. */
export const closedInKind = (kind: string | null | undefined) =>
  kind && (RESOLUTION_KINDS as readonly string[]).includes(kind) ? kind : 'verified'

/**
 * What a hand-off ending does here, as reported by `croft sync`:
 *
 *  - the subject's log gets `<ref> done: <resolution>`, once (keyed on the
 *    tracker, ref and status, so a resolution revised there adds nothing);
 *  - the todo is closed with the same status, because once handed off the
 *    tracker owns it. A todo already done or cancelled is left as it is.
 *
 * The one path that closes a handed-off todo.
 */
export const applyHandoffOutcome = async (
  actor: Actor,
  todo: OutcomeTodo,
  outcome: { tracker: string; ref: string; status: string; resolution?: string | null; resolutionKind?: string | null },
): Promise<{ noted: boolean; closed: boolean }> => {
  const status = outcome.status
  if (!isTerminalHandoff(status)) return { noted: false, closed: false }

  let noted = false
  if (todo.subject_id) {
    const written = await addSubjectNote(
      actor,
      todo.subject_id,
      {
        kind: status === 'done' ? 'finding' : 'note',
        note: handoffOutcomeNote(outcome.ref, status, outcome.resolution),
      },
      handoffOutcomeHash(outcome.tracker, outcome.ref, status),
    )
    noted = !written.duplicate
  }

  let closed = false
  if (!isTerminal(todo.status as TaskStatus)) {
    await closeTask(actor, todo, {
      status,
      resolution: closedInResolution(outcome.tracker, outcome.ref, outcome.resolution),
      resolutionKind: closedInKind(outcome.resolutionKind),
    })
    closed = true
  }
  return { noted, closed }
}

type LinkInput = {
  tracker: string
  ref: string
  url?: string | null
  status?: string
  resolution?: string
  resolutionKind?: string
}

/**
 * Records that a todo was filed in a tracker, or re-links it (overwrite).
 * Written by `croft handoff` after the task exists there, so the link never
 * points at nothing. The subject's log says where the work went, once per
 * link: a sync reporting the same task again adds nothing.
 *
 * `croft sync` calls this too, with the status the tracker reported: done or
 * cancelled records the outcome and closes the todo.
 */
export const linkHandoff = async (
  actor: Actor,
  task: { id: string; ref: string; subject_id: string | null },
  input: LinkInput,
) => {
  const before = handoffOf(
    (await pool().query(`select ${HANDOFF_COLUMNS} from tasks where id = $1`, [task.id])).rows[0] as object | undefined,
  )
  const same = before?.tracker === input.tracker && before.ref === input.ref

  const result = await pool().query(
    `update tasks
        set handoff_tracker = $2,
            handoff_ref = $3,
            handoff_url = case when $4::text is not null then $4::text when $6::boolean then handoff_url else null end,
            handoff_status = case when $5::text is not null then $5::text when $6::boolean then handoff_status else null end,
            handoff_synced_at = now()
      where id = $1
      returning id, ${HANDOFF_COLUMNS}, subject_id, status, resolution, resolution_kind, claimed_by`,
    [task.id, input.tracker, input.ref, input.url ?? null, input.status ?? null, same],
  )
  const row = (normalizeDatabaseValue(result.rows) as (OutcomeTodo & HandoffColumns)[])[0]
  if (!row) return { ref: task.ref, noted: false, closed: false }

  if (row.subject_id && !same) {
    await addSubjectNote(actor, row.subject_id, {
      kind: 'handoff',
      note: `${task.ref} handed off to ${input.tracker} as ${input.ref}`,
    })
  }
  const outcome = input.status
    ? await applyHandoffOutcome(actor, row, {
        tracker: input.tracker,
        ref: input.ref,
        status: input.status,
        resolution: input.resolution,
        resolutionKind: input.resolutionKind,
      })
    : { noted: false, closed: false }

  const shaped = withHandoff(row) as unknown as { handoff: Handoff | null }
  return {
    ref: task.ref,
    id: row.id,
    subject_id: row.subject_id,
    handoff: shaped.handoff,
    // The todo's own status, after any close this link caused.
    status: outcome.closed ? input.status : row.status,
    ...outcome,
  }
}

/**
 * Takes a hand-off back: clears the link and says so in the subject's log.
 * Nothing is done in the other tracker. Null when the todo is not handed off.
 */
export const unlinkHandoff = async (
  actor: Actor,
  task: { id: string; ref: string; subject_id: string | null },
): Promise<Handoff | null> => {
  const result = await pool().query(
    `update tasks t
        set handoff_tracker = null, handoff_ref = null, handoff_url = null,
            handoff_status = null, handoff_synced_at = null
       from (select id, ${HANDOFF_COLUMNS} from tasks where id = $1 for update) old
      where t.id = old.id and old.handoff_ref is not null
      returning old.handoff_tracker, old.handoff_ref, old.handoff_url, old.handoff_status, old.handoff_synced_at`,
    [task.id],
  )
  const taken = handoffOf((normalizeDatabaseValue(result.rows) as object[])[0])
  if (!taken) return null
  if (task.subject_id) {
    await addSubjectNote(actor, task.subject_id, {
      kind: 'handoff',
      note: `${task.ref} taken back from ${taken.tracker} (${taken.ref})`,
    })
  }
  return taken
}

import { createHash } from 'node:crypto'
import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import type { Actor } from './auth'
import { isTerminal, RESOLUTION_KINDS, type TaskStatus } from '@/schemas/task'
import { addSubjectNote } from './subjects'
import { closeTask } from './tasks'

/**
 * The hand-off to Cairn.
 *
 * A todo that turns into real engineering work is pushed through the agent
 * machine's Cairn CLI
 * (`croft push T-41 --to CAIRN` files it there and records the link here).
 * Sync then reads each linked Cairn task back and, when Cairn closes it,
 * writes the outcome into the subject's log once — so the lab learns how the
 * work it spun off ended without anyone copying it across.
 */

export const TERMINAL_CAIRN_STATUSES = ['done', 'cancelled'] as const

/** `CAIRN-331 done: <resolution>` — the line a closed Cairn task leaves in the subject's log. */
export const cairnOutcomeNote = (cairnRef: string, status: string, resolution: string | null | undefined) =>
  `${cairnRef} ${status}${resolution?.trim() ? `: ${resolution.trim()}` : ''}`

/**
 * Keyed on the Cairn ref and the terminal status, not the text: a resolution
 * revised in Cairn afterwards must not add a second "done" line.
 */
export const cairnOutcomeHash = (cairnRef: string, status: string) =>
  createHash('sha256').update(`cairn\n${cairnRef}\n${status}`, 'utf8').digest('hex').slice(0, 32)

type OutcomeTodo = {
  id: string
  status: string
  resolution: string | null
  resolution_kind: string | null
  claimed_by: string | null
  subject_id: string | null
}

const isTerminalCairn = (status: string | null | undefined): status is 'done' | 'cancelled' =>
  Boolean(status) && (TERMINAL_CAIRN_STATUSES as readonly string[]).includes(status as string)

/** What closing a todo says about the Cairn task that ended it. */
export const closedInCairnResolution = (cairnRef: string, resolution: string | null | undefined) =>
  `Closed in Cairn as ${cairnRef}${resolution?.trim() ? `: ${resolution.trim()}` : ''}`

/** Cairn's kind when it is one Croft has; `verified` otherwise — the lab checked Cairn's answer. */
export const closedInCairnKind = (kind: string | null | undefined) =>
  kind && (RESOLUTION_KINDS as readonly string[]).includes(kind) ? kind : 'verified'

/**
 * What a Cairn task ending does here, as reported by `croft sync` through
 * the agent machine's Cairn CLI:
 *
 *  - the subject's log gets `CAIRN-331 done: <resolution>`, once (keyed on
 *    the ref and status, so a resolution revised in Cairn adds nothing);
 *  - the todo is closed with the same status, because once pushed Cairn owns
 *    it. A todo already done or cancelled is left as it is.
 */
export const applyCairnOutcome = async (
  actor: Actor,
  todo: OutcomeTodo,
  cairn: { ref: string; status: string; resolution?: string | null; resolutionKind?: string | null },
): Promise<{ noted: boolean; closed: boolean }> => {
  if (!isTerminalCairn(cairn.status)) return { noted: false, closed: false }

  let noted = false
  if (todo.subject_id) {
    const written = await addSubjectNote(
      actor,
      todo.subject_id,
      {
        kind: cairn.status === 'done' ? 'finding' : 'note',
        note: cairnOutcomeNote(cairn.ref, cairn.status, cairn.resolution),
      },
      cairnOutcomeHash(cairn.ref, cairn.status),
    )
    noted = !written.duplicate
  }

  let closed = false
  if (!isTerminal(todo.status as TaskStatus)) {
    await closeTask(actor, todo, {
      status: cairn.status,
      resolution: closedInCairnResolution(cairn.ref, cairn.resolution),
      resolutionKind: closedInCairnKind(cairn.resolutionKind),
    })
    closed = true
  }
  return { noted, closed }
}

/**
 * Records that a todo was filed in Cairn. Written by `croft push` after
 * `cairn add` succeeds, and noted on the subject so the log says where the
 * work went.
 *
 * `croft sync` through the agent machine's Cairn CLI calls this too, with
 * the status Cairn reported: done or cancelled records the outcome and closes
 * the todo.
 */
export const linkTodoToCairn = async (
  actor: Actor,
  task: { id: string; ref: string; subject_id: string | null },
  input: { cairnRef: string; cairnStatus?: string; cairnResolution?: string; cairnResolutionKind?: string },
) => {
  const result = await pool().query(
    `update tasks
        set cairn_ref = $2, cairn_status = coalesce($3, cairn_status), cairn_synced_at = now()
      where id = $1
      returning id, cairn_ref, cairn_status, cairn_synced_at, subject_id,
                status, resolution, resolution_kind, claimed_by`,
    [task.id, input.cairnRef, input.cairnStatus ?? null],
  )
  const row = (normalizeDatabaseValue(result.rows) as (OutcomeTodo & {
    cairn_ref: string
    cairn_status: string | null
    cairn_synced_at: string
  })[])[0]
  if (!row) return { ref: task.ref, noted: false, closed: false }

  if (row.subject_id) {
    await addSubjectNote(actor, row.subject_id, {
      kind: 'handoff',
      note: `${task.ref} pushed to Cairn as ${input.cairnRef}`,
    })
  }
  const outcome = input.cairnStatus
    ? await applyCairnOutcome(actor, row, {
        ref: input.cairnRef,
        status: input.cairnStatus,
        resolution: input.cairnResolution,
        resolutionKind: input.cairnResolutionKind,
      })
    : { noted: false, closed: false }

  return {
    ref: task.ref,
    id: row.id,
    subject_id: row.subject_id,
    cairn_ref: row.cairn_ref,
    cairn_status: row.cairn_status,
    cairn_synced_at: row.cairn_synced_at,
    // The todo's own status, after any close this link caused.
    status: outcome.closed ? input.cairnStatus : row.status,
    ...outcome,
  }
}

import type { Handoff } from '@/lib/lab/types'
import { fail } from './response'

/**
 * The shape of a hand-off on a task row, and the refusal that goes with it.
 * Pure, so every route and list can use it without pulling in the writers.
 */

export const TERMINAL_HANDOFF_STATUSES = ['done', 'cancelled'] as const

/** The raw columns, for a select on `tasks` (alias `t.` is the caller's to add). */
export const HANDOFF_COLUMNS = 'handoff_tracker, handoff_ref, handoff_url, handoff_status, handoff_synced_at'

export type HandoffColumns = {
  handoff_tracker?: unknown
  handoff_ref?: unknown
  handoff_url?: unknown
  handoff_status?: unknown
  handoff_synced_at?: unknown
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null)

/** The hand-off a task row carries, or null. */
export const handoffOf = (source: object | null | undefined): Handoff | null => {
  const row = source as HandoffColumns | null | undefined
  const tracker = text(row?.handoff_tracker)
  const ref = text(row?.handoff_ref)
  if (!tracker || !ref) return null
  return {
    tracker,
    ref,
    url: text(row?.handoff_url),
    status: text(row?.handoff_status),
    synced_at: text(row?.handoff_synced_at),
  }
}

/**
 * Raw `handoff_*` columns become the `handoff` object. A row that was not
 * selected with the columns passes through untouched.
 */
export const withHandoff = <T>(row: T): T => {
  if (!row || typeof row !== 'object' || !('handoff_ref' in row)) return row
  const {
    handoff_tracker: _tracker,
    handoff_ref: _ref,
    handoff_url: _url,
    handoff_status: _status,
    handoff_synced_at: _syncedAt,
    ...rest
  } = row as HandoffColumns & Record<string, unknown>
  return { ...rest, handoff: handoffOf(row as HandoffColumns) } as T
}

export const withHandoffs = <T>(rows: readonly T[]): T[] => rows.map(withHandoff)

/** A hand-off whose tracker has not ended the task: it still owns the status. */
export const isHandedOff = (row: object | null | undefined) => {
  const handoff = handoffOf(row)
  return handoff !== null && !isTerminalHandoff(handoff.status)
}

/**
 * 409 `handed_off`, for a status change on a todo whose tracker owns its
 * status. Edits to title and body never go through here.
 */
export const refuseHandedOff = (
  row: object | null | undefined,
  taskRef: string,
): Response | null => {
  const handoff = handoffOf(row)
  if (!handoff || isTerminalHandoff(handoff.status)) return null
  return fail(
    'handed_off',
    `${taskRef} was handed off to ${handoff.tracker} as ${handoff.ref}, which owns its status now: work it ` +
      `there (croft sync brings the outcome back), or take it back: croft handoff ${taskRef} --undo`,
    { tracker: handoff.tracker, handoffRef: handoff.ref, url: handoff.url },
  )
}

export const isTerminalHandoff = (status: string | null | undefined): status is 'done' | 'cancelled' =>
  Boolean(status) && (TERMINAL_HANDOFF_STATUSES as readonly string[]).includes(status as string)

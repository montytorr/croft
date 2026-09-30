import { createHash } from 'node:crypto'
import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import { openSecret, sealSecret, SecretUnreadableError } from '@/lib/secret-box'
import type { CairnConnection } from '@/lib/lab/types'
import type { Actor } from './auth'
import { isTerminal, RESOLUTION_KINDS, type TaskStatus } from '@/schemas/task'
import { addSubjectNote } from './subjects'
import { closeTask } from './tasks'

/**
 * The hand-off to Cairn.
 *
 * A todo that turns into real engineering work is pushed to the group's Cairn
 * (`croft push T-41 --to CAIRN` files it there and records the link here).
 * Sync then reads each linked Cairn task back and, when Cairn closes it,
 * writes the outcome into the subject's log once — so the lab learns how the
 * work it spun off ended without anyone copying it across.
 */

/**
 * `api_key` is sealed (src/lib/secret-box.ts). `api_key_plaintext` marks a key
 * stored before 073, which is read once as it is and sealed on the spot.
 */
type ConnectionRow = {
  url: string | null
  api_key: string | null
  api_key_plaintext: boolean
  last_synced_at: string | null
}

/** The associated data every sealed Cairn key is bound to. */
const KEY_PURPOSE = 'cairn_connection.api_key'

const readConnection = async (): Promise<ConnectionRow | null> => {
  const result = await pool().query(
    'select url, api_key, api_key_plaintext, last_synced_at from cairn_connection where id',
  )
  return (normalizeDatabaseValue(result.rows) as ConnectionRow[])[0] ?? null
}

/**
 * The key, in the clear, for presenting to Cairn. A legacy plaintext key is
 * sealed in place the first time it is read; the update is conditional on the
 * row still holding that plaintext, so a key saved meanwhile is not undone.
 */
const cairnKey = async (row: ConnectionRow): Promise<string | null> => {
  if (!row.api_key) return null
  if (!row.api_key_plaintext) return openSecret(row.api_key, KEY_PURPOSE)
  await pool().query(
    `update cairn_connection set api_key = $1, api_key_plaintext = false
      where id and api_key_plaintext and api_key = $2`,
    [sealSecret(row.api_key, KEY_PURPOSE), row.api_key],
  )
  return row.api_key
}

/** What anyone may be told about the connection. Never the key. */
export const describeConnection = (
  row: Pick<ConnectionRow, 'url' | 'api_key' | 'last_synced_at'> | null,
): CairnConnection => ({
  url: row?.url ?? null,
  key_set: Boolean(row?.api_key),
  last_synced_at: row?.last_synced_at ?? null,
})

export const getCairnConnection = async (): Promise<CairnConnection> => describeConnection(await readConnection())

/**
 * Sets where Cairn is and, optionally, the key. `apiKey` undefined keeps the
 * stored one — the form never has it to send back — and null clears it.
 */
export const saveCairnConnection = async (
  actor: Pick<Actor, 'userId'>,
  input: { url: string | null; apiKey?: string | null },
): Promise<CairnConnection> => {
  const keepKey = input.apiKey === undefined
  const sealed = input.apiKey ? sealSecret(input.apiKey, KEY_PURPOSE) : null
  await pool().query(
    `insert into cairn_connection (id, url, api_key, api_key_plaintext, updated_at, updated_by)
     values (true, $1, $2, false, now(), $3)
     on conflict (id) do update set
       url               = excluded.url,
       api_key           = case when $4 then cairn_connection.api_key else excluded.api_key end,
       api_key_plaintext = case when $4 then cairn_connection.api_key_plaintext else false end,
       updated_at        = now(),
       updated_by        = excluded.updated_by`,
    [input.url, sealed, actor.userId, keepKey],
  )
  // A kept key from before 073 is sealed on this write rather than left in
  // the clear until the next sync happens to read it.
  const saved = await readConnection()
  if (saved?.api_key_plaintext) await cairnKey(saved)
  return describeConnection(saved)
}

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

type LinkedTodo = {
  id: string
  ref: string
  status: string
  resolution: string | null
  resolution_kind: string | null
  claimed_by: string | null
  subject_id: string | null
  cairn_ref: string
  cairn_status: string | null
}

export type SyncFailure = { ref: string; cairn_ref: string; error: string }

/** One todo's line in the sync: the shape `croft sync` prints as a table. */
export type SyncResult = {
  ref: string
  cairnRef: string
  cairnStatus: string | null
  /** `unchanged`, `was doing`, `unread: <why>`; `· noted` / `· closed` when those happened. */
  result: string
}

export type SyncReport = {
  checked: number
  updated: number
  concluded: number
  /** Croft todos closed because their Cairn task ended. */
  closed: number
  failed: SyncFailure[]
  results: SyncResult[]
  last_synced_at: string | null
}

type CairnTask = { status?: string; resolution?: string | null; resolution_kind?: string | null }

const isTerminalCairn = (status: string | null | undefined): status is 'done' | 'cancelled' =>
  Boolean(status) && (TERMINAL_CAIRN_STATUSES as readonly string[]).includes(status as string)

/** What closing a todo says about the Cairn task that ended it. */
export const closedInCairnResolution = (cairnRef: string, resolution: string | null | undefined) =>
  `Closed in Cairn as ${cairnRef}${resolution?.trim() ? `: ${resolution.trim()}` : ''}`

/** Cairn's kind when it is one Croft has; `verified` otherwise — the lab checked Cairn's answer. */
export const closedInCairnKind = (kind: string | null | undefined) =>
  kind && (RESOLUTION_KINDS as readonly string[]).includes(kind) ? kind : 'verified'

type OutcomeTodo = Pick<LinkedTodo, 'id' | 'status' | 'resolution' | 'resolution_kind' | 'claimed_by' | 'subject_id'>

/**
 * What a Cairn task ending does here, however Croft learned of it — the
 * server's sync or `croft sync` through this machine's cairn CLI:
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

const describeResult = (previous: string | null, status: string, outcome: { noted: boolean; closed: boolean }) =>
  [
    status === previous ? 'unchanged' : `was ${previous ?? 'unknown'}`,
    outcome.noted ? 'noted' : '',
    outcome.closed ? 'closed' : '',
  ]
    .filter(Boolean)
    .join(' · ')

const fetchCairnTask = async (
  base: string,
  key: string,
  ref: string,
  fetcher: typeof fetch,
): Promise<{ ok: true; task: CairnTask } | { ok: false; error: string }> => {
  try {
    const response = await fetcher(`${base}/api/v1/tasks/${encodeURIComponent(ref)}`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
    const payload = (await response.json().catch(() => null)) as
      | { success?: boolean; data?: CairnTask; error?: string }
      | null
    if (!response.ok || !payload?.success || !payload.data) {
      return { ok: false, error: payload?.error ?? `Cairn answered ${response.status}` }
    }
    return { ok: true, task: payload.data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'request failed' }
  }
}

/** A few at a time: a board's worth of todos should not be a burst on Cairn. */
const inBatches = async <T>(items: T[], size: number, run: (item: T) => Promise<void>) => {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(run))
  }
}

/**
 * Pulls every linked todo's Cairn status. One failure is recorded and the
 * rest carry on: an unreachable task (deleted, renamed, no access) must not
 * stop the others from updating.
 */
export const syncCairn = async (
  actor: Actor,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: true; report: SyncReport } | { ok: false; reason: 'not_connected' | 'key_unreadable' }> => {
  const connection = await readConnection()
  if (!connection?.url || !connection.api_key) return { ok: false, reason: 'not_connected' }
  const base = connection.url.replace(/\/+$/, '')
  let key: string | null
  try {
    key = await cairnKey(connection)
  } catch (error) {
    if (error instanceof SecretUnreadableError) return { ok: false, reason: 'key_unreadable' }
    throw error
  }
  if (!key) return { ok: false, reason: 'not_connected' }

  const linked = normalizeDatabaseValue(
    (
      await pool().query(
        `select t.id, p.key || '-' || t.number as ref, t.status, t.resolution, t.resolution_kind, t.claimed_by,
                t.subject_id, t.cairn_ref, t.cairn_status
           from tasks t
           join projects p on p.id = t.project_id
          where t.cairn_ref is not null
            -- Only the todos the caller may see: the report names each one,
            -- and an outcome is written into its subject's log as the caller.
            -- A private todo syncs when its owner or a member syncs.
            and croft_task_visible(t.subject_id, $1::uuid)
          order by t.updated_at`,
        [actor.userId],
      )
    ).rows,
  ) as LinkedTodo[]

  const report: SyncReport = {
    checked: linked.length,
    updated: 0,
    concluded: 0,
    closed: 0,
    failed: [],
    results: [],
    last_synced_at: null,
  }
  const results = new Map<string, SyncResult>()

  await inBatches(linked, 4, async (todo) => {
    const fetched = await fetchCairnTask(base, key, todo.cairn_ref, fetcher)
    if (!fetched.ok) {
      report.failed.push({ ref: todo.ref, cairn_ref: todo.cairn_ref, error: fetched.error })
      results.set(todo.id, {
        ref: todo.ref,
        cairnRef: todo.cairn_ref,
        cairnStatus: todo.cairn_status,
        result: `unread: ${fetched.error}`,
      })
      return
    }
    const status = fetched.task.status ?? null
    await pool().query(
      `update tasks set cairn_status = $2, cairn_synced_at = now() where id = $1`,
      [todo.id, status],
    )
    if (status !== todo.cairn_status) report.updated += 1

    const outcome = status
      ? await applyCairnOutcome(actor, todo, {
          ref: todo.cairn_ref,
          status,
          resolution: fetched.task.resolution,
          resolutionKind: fetched.task.resolution_kind,
        })
      : { noted: false, closed: false }
    if (outcome.noted) report.concluded += 1
    if (outcome.closed) report.closed += 1
    results.set(todo.id, {
      ref: todo.ref,
      cairnRef: todo.cairn_ref,
      cairnStatus: status,
      result: status ? describeResult(todo.cairn_status, status, outcome) : 'unread: Cairn sent no status',
    })
  })
  // In the order the todos were read, not the order the batches finished.
  report.results = linked.map((todo) => results.get(todo.id)).filter((r): r is SyncResult => Boolean(r))

  const stamped = await pool().query(
    'update cairn_connection set last_synced_at = now() where id returning last_synced_at',
  )
  report.last_synced_at =
    (normalizeDatabaseValue(stamped.rows) as { last_synced_at: string }[])[0]?.last_synced_at ?? null
  return { ok: true, report }
}

/**
 * Records that a todo was filed in Cairn. Written by `croft push` after
 * `cairn add` succeeds, and noted on the subject so the log says where the
 * work went.
 *
 * `croft sync` through a machine's own cairn CLI (no server connection)
 * calls this too, with the status Cairn reported: a done or cancelled one has
 * the same effect as the server's sync — the outcome line and the close.
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

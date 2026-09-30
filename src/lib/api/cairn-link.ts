import { createHash } from 'node:crypto'
import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import type { CairnConnection } from '@/lib/lab/types'
import type { Actor } from './auth'
import { addSubjectNote } from './subjects'

/**
 * The hand-off to Cairn.
 *
 * A todo that turns into real engineering work is pushed to the group's Cairn
 * (`croft push T-41 --to CAIRN` files it there and records the link here).
 * Sync then reads each linked Cairn task back and, when Cairn closes it,
 * writes the outcome into the subject's log once — so the lab learns how the
 * work it spun off ended without anyone copying it across.
 */

type ConnectionRow = { url: string | null; api_key: string | null; last_synced_at: string | null }

const readConnection = async (): Promise<ConnectionRow | null> => {
  const result = await pool().query('select url, api_key, last_synced_at from cairn_connection where id')
  return (normalizeDatabaseValue(result.rows) as ConnectionRow[])[0] ?? null
}

/** What anyone may be told about the connection. Never the key. */
export const describeConnection = (row: ConnectionRow | null): CairnConnection => ({
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
  await pool().query(
    `insert into cairn_connection (id, url, api_key, updated_at, updated_by)
     values (true, $1, $2, now(), $3)
     on conflict (id) do update set
       url        = excluded.url,
       api_key    = case when $4 then cairn_connection.api_key else excluded.api_key end,
       updated_at = now(),
       updated_by = excluded.updated_by`,
    [input.url, keepKey ? null : input.apiKey, actor.userId, keepKey],
  )
  return getCairnConnection()
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
  subject_id: string | null
  cairn_ref: string
  cairn_status: string | null
}

export type SyncFailure = { ref: string; cairn_ref: string; error: string }

export type SyncReport = {
  checked: number
  updated: number
  concluded: number
  failed: SyncFailure[]
  last_synced_at: string | null
}

type CairnTask = { status?: string; resolution?: string | null }

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
): Promise<{ ok: true; report: SyncReport } | { ok: false; reason: 'not_connected' }> => {
  const connection = await readConnection()
  if (!connection?.url || !connection.api_key) return { ok: false, reason: 'not_connected' }
  const base = connection.url.replace(/\/+$/, '')
  const key = connection.api_key

  const linked = normalizeDatabaseValue(
    (
      await pool().query(
        `select t.id, p.key || '-' || t.number as ref, t.subject_id, t.cairn_ref, t.cairn_status
           from tasks t
           join projects p on p.id = t.project_id
          where t.cairn_ref is not null
          order by t.updated_at`,
      )
    ).rows,
  ) as LinkedTodo[]

  const report: SyncReport = { checked: linked.length, updated: 0, concluded: 0, failed: [], last_synced_at: null }

  await inBatches(linked, 4, async (todo) => {
    const fetched = await fetchCairnTask(base, key, todo.cairn_ref, fetcher)
    if (!fetched.ok) {
      report.failed.push({ ref: todo.ref, cairn_ref: todo.cairn_ref, error: fetched.error })
      return
    }
    const status = fetched.task.status ?? null
    await pool().query(
      `update tasks set cairn_status = $2, cairn_synced_at = now() where id = $1`,
      [todo.id, status],
    )
    if (status !== todo.cairn_status) report.updated += 1

    if (status && (TERMINAL_CAIRN_STATUSES as readonly string[]).includes(status) && todo.subject_id) {
      const written = await addSubjectNote(
        actor,
        todo.subject_id,
        {
          kind: status === 'done' ? 'finding' : 'note',
          note: cairnOutcomeNote(todo.cairn_ref, status, fetched.task.resolution),
        },
        cairnOutcomeHash(todo.cairn_ref, status),
      )
      if (!written.duplicate) report.concluded += 1
    }
  })

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
 */
export const linkTodoToCairn = async (
  actor: Actor,
  task: { id: string; ref: string; subject_id: string | null },
  input: { cairnRef: string; cairnStatus?: string },
) => {
  const result = await pool().query(
    `update tasks
        set cairn_ref = $2, cairn_status = coalesce($3, cairn_status), cairn_synced_at = now()
      where id = $1
      returning id, cairn_ref, cairn_status, cairn_synced_at, subject_id`,
    [task.id, input.cairnRef, input.cairnStatus ?? null],
  )
  const row = (normalizeDatabaseValue(result.rows) as {
    id: string
    cairn_ref: string
    cairn_status: string | null
    cairn_synced_at: string
    subject_id: string | null
  }[])[0]

  if (row?.subject_id) {
    await addSubjectNote(actor, row.subject_id, {
      kind: 'handoff',
      note: `${task.ref} pushed to Cairn as ${input.cairnRef}`,
    })
  }
  return { ref: task.ref, ...row }
}

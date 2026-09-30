import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { searchAll, searchTasks, type SearchAllRow, type SearchRow } from '@/lib/api/search'
import { TASK_STATUSES, TASK_TYPES } from '@/schemas/task'
import { admin } from '@/lib/db/client'
import { liveProjectKey } from '@/lib/api/project-keys'
import { resolveAssignee } from '@/lib/api/people'
import { visibleSubjectIds } from '@/lib/api/visibility'

export const dynamic = 'force-dynamic'

const searchQuery = z.object({
  q: z.string().min(1).max(500),
  project: z.string().optional(),
  type: z.enum(TASK_TYPES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /**
   * Which stores to search. Defaults to all of them — an agent asking whether
   * something has been debugged does not know, and should not have to guess,
   * whether the answer was written as a task, a note or a subject.
   */
  kinds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((k) => k.trim()).filter(Boolean) : undefined)),
  tasksOnly: z.coerce.boolean().default(false),
  /** Whose tasks: `me` (the human behind the key), an email, a name or an id. */
  assignee: z.string().trim().min(1).max(320).optional(),
})

/**
 * Rough token cost of expanding a row, advertised so the caller can decide
 * whether it is worth fetching. Approximate on purpose — the point is
 * order-of-magnitude budgeting, not accuracy.
 */
const estimateTokens = (...parts: (string | null | undefined)[]) =>
  Math.ceil(parts.filter(Boolean).join(' ').length / 4)

/**
 * The read half of Croft-as-memory. An agent asks "has this already been done
 * or debugged?" before starting, and gets back an INDEX — ids, one-liners, and
 * what each costs to open. Never bodies: returning those in bulk is exactly the
 * waste that makes 61% of large reads never get looked at again.
 *
 * Closed tasks are included on purpose, and ones carrying a resolution rank
 * above ones that do not, because a recorded answer is the most valuable thing
 * the system holds.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = searchQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) {
      return fail('validation_failed', 'Provide ?q=<subject>.', { issues: parsed.error.issues })
    }
    const { q, type, status, limit, kinds, tasksOnly } = parsed.data
    // `--project AC` searches the project AC became. Matched as a string it
    // filtered on a key no row carries any more, and "nothing found — this
    // subject looks new" is the most misleading thing check can say.
    const { key: project, renamed } = await liveProjectKey(parsed.data.project)
    const told = renamed ? { renamed_from: renamed } : {}

    // Resolved rather than matched, and a name nobody has is refused: "nothing
    // found — this subject looks new" is the wrong answer to a typo.
    const owner = parsed.data.assignee ? await resolveAssignee(parsed.data.assignee, actor.userId) : null
    if (owner && !owner.ok) return fail(owner.code, owner.error)
    const assignee = owner?.ok ? owner.person.id : undefined

    // A type, status or assignee filter is a statement about tasks, so it
    // selects the task-only path rather than being silently ignored on the
    // others.
    const taskPath =
      tasksOnly || Boolean(type) || Boolean(status) || Boolean(assignee) || kinds?.join() === 'task'

    try {
      if (taskPath) {
        const { rows, widened } = await searchTasks(actor.userId, q, { project, type, status, assignee }, limit)
        const results = rows.map(taskResult)
        return ok({ count: rows.length, query: q, widened, results, ...told })
      }

      const { rows, widened } = await searchAll(actor.userId, q, { project, kinds }, limit)

      const results = rows.map(unifiedResult)
      await attachConclusions(rows, results, actor.userId)
      return ok({ count: rows.length, query: q, widened, results, ...told })
    } catch (error) {
      return fail('internal_error', error instanceof Error ? error.message : 'Search failed.')
    }
  },
})

/**
 * A subject's conclusion is its recorded answer — what a task's resolution is
 * to a task — so a subject hit carries it, clipped, where the index row only
 * had room for a 120-character subtitle. One query for every subject hit.
 */
const CONCLUSION_CLIP = 500
const attachConclusions = async (
  rows: SearchAllRow[],
  results: ReturnType<typeof unifiedResult>[],
  viewerId: string,
) => {
  // search_all already keeps to what the viewer may see; checked again here
  // because this reads the subjects table directly.
  const ids = [...(await visibleSubjectIds(rows.filter((r) => r.kind === 'subject').map((r) => r.id), viewerId))]
  if (ids.length === 0) return
  const { data } = await admin().from('subjects').select('id, conclusion').in('id', ids)
  const byId = new Map(((data ?? []) as { id: string; conclusion: string | null }[]).map((s) => [s.id, s.conclusion]))
  rows.forEach((row, i) => {
    const result = results[i]
    if (row.kind !== 'subject' || !result) return
    const conclusion = byId.get(row.id)?.trim() || null
    result.conclusion =
      conclusion && conclusion.length > CONCLUSION_CLIP ? `${conclusion.slice(0, CONCLUSION_CLIP)}…` : conclusion
  })
}

// Rows arrive ranked by the database. Do NOT re-sort them here: ordering by
// anything other than ts_rank discards relevance, which is exactly the
// regression 004 measured and 007 restored.
const taskResult = (row: SearchRow) => ({
  kind: 'task' as const,
  // ALWAYS the Croft ref: it is what `croft show` resolves. Returning the
  // imported identifier here hands the caller something that looks like a ref
  // and 404s, because no project has key "LEGACY".
  ref: `${row.project_key}-${row.number}`,
  // The original identifier, for recognising old work. Not addressable.
  externalRef: row.external_ref,
  title: row.title,
  type: row.type,
  status: row.status,
  resolved: Boolean(row.resolution),
  resolutionKind: row.resolution_kind,
  claimedBy: row.claimed_by,
  updatedAt: row.updated_at,
  // Widened hits matched loosely; say so rather than implying precision.
  loose: row.widened,
  tokens: estimateTokens(row.description, row.resolution),
  ...(row.renamed_from ? { requestedRef: row.requested_ref, renamedFrom: row.renamed_from } : {}),
})

const unifiedResult = (row: SearchAllRow) => ({
  kind: row.kind,
  ref: row.ref,
  title: row.title,
  subtitle: row.subtitle,
  project: row.project_key,
  type: row.type,
  status: row.status,
  // For a task this is a recorded resolution; for a note, that it is a finding
  // or a decision rather than an attempt; for a subject, a recorded conclusion.
  // In every case: this row is likelier to contain an answer.
  resolved: row.answered,
  updatedAt: row.updated_at,
  loose: row.widened,
  tokens: Math.ceil(row.body_bytes / 4),
  // The exact-ref row only, when the ref went through a retired key.
  ...(row.renamed_from ? { requestedRef: row.requested_ref, renamedFrom: row.renamed_from } : {}),
  /**
   * Subjects only: the stage (also in `status`, which is where every kind
   * keeps its state) and the conclusion, filled in by `attachConclusions`.
   * `tokens` above is the write-up plus the conclusion, estimated the way a
   * task's description plus resolution is.
   */
  ...(row.kind === 'subject' ? { stage: row.status, conclusion: null as string | null } : {}),
})

import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { searchAll, type SearchAllRow } from '@/lib/api/search'
import { admin } from '@/lib/db/client'
import { visibleSubjectIds } from '@/lib/api/visibility'

export const dynamic = 'force-dynamic'

const searchQuery = z.object({
  q: z.string().min(1).max(500),
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
})

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
    const { q, limit, kinds } = parsed.data

    try {
      const { rows, widened } = await searchAll(actor.userId, q, { kinds }, limit)

      const results = rows.map(unifiedResult)
      await attachConclusions(rows, results, actor.userId)
      return ok({ count: rows.length, query: q, widened, results })
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
  /**
   * Subjects only: the stage (also in `status`, which is where every kind
   * keeps its state) and the conclusion, filled in by `attachConclusions`.
   * `tokens` above is the write-up plus the conclusion, estimated the way a
   * task's description plus resolution is.
   */
  ...(row.kind === 'subject' ? { stage: row.status, conclusion: null as string | null } : {}),
})

import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

const renameBody = z.object({
  from: z.string().min(1).max(50),
  /**
   * The new name. Renaming onto a label that already exists merges the two.
   * `null` deletes `from` from every task instead.
   */
  to: z.string().min(1).max(50).nullable(),
})

/**
 * Every label in use, with how many tasks carry it. Busiest first. Counted
 * over the tasks this viewer can see: a label only someone's private todos
 * carry is not in anyone else's list (migration 076).
 */
export const GET = route({
  handler: async ({ actor }) => {
    const { data, error } = await admin().rpc('list_labels', { p_owner: actor.userId })
    if (error) return fail('internal_error', error.message)
    return ok(data ?? [])
  },
})

/**
 * Rename, merge or delete — one operation, because a rename onto an existing
 * label *is* a merge. The work happens in a single statement in the database;
 * doing it here would mean reading every task, rewriting its array and writing
 * it back one row at a time. It touches only the tasks the caller can see, so
 * `tasksChanged` never counts someone else's private todos (migration 076).
 */
export const PATCH = route<Record<string, string>, z.infer<typeof renameBody>>({
  schema: renameBody,
  handler: async ({ actor, body }) => {
    if (body.to !== null && body.to.trim() === body.from.trim()) {
      return fail('validation_failed', 'That is the same label.')
    }

    const { data, error } = await admin().rpc('rename_label', {
      p_owner: actor.userId,
      p_from: body.from.trim(),
      p_to: body.to === null ? null : body.to.trim(),
    })
    if (error) return fail('internal_error', error.message)

    const changed = (data as number) ?? 0
    return ok({
      from: body.from.trim(),
      to: body.to === null ? null : body.to.trim(),
      tasksChanged: changed,
      // Said plainly, because a rename that matched nothing looks identical to
      // one that worked.
      note: changed === 0 ? `No task carries "${body.from.trim()}".` : undefined,
    })
  },
})

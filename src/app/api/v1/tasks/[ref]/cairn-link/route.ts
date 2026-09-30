import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { findTask, refOfRow, refuseArchived } from '@/lib/api/tasks'
import { linkTodoToCairn } from '@/lib/api/cairn-link'
import { cairnLinkSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/**
 * Records that `croft push` filed this task in Cairn. Written after the Cairn
 * task exists, so the link never points at nothing. Re-linking overwrites.
 */
export const POST = route<{ ref: string }, z.infer<typeof cairnLinkSchema>>({
  schema: cairnLinkSchema,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, 'id, number, subject_id, project:projects!project_id!inner(key, status)')
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    const linked = await linkTodoToCairn(
      actor,
      { id: task.id, ref: refOfRow(task) ?? params.ref, subject_id: (task.subject_id as string | null) ?? null },
      body,
    )
    return ok(linked)
  },
})

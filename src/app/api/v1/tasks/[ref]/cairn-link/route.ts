import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { findTask, refOfRow, refuseArchived, subjectOfTask } from '@/lib/api/tasks'
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

    // Cairn has no notion of who may see what: a todo of a private or
    // members-only subject leaves for it only when the caller says so.
    const subject = await subjectOfTask(task.subject_id, actor.userId)
    if (subject && subject.visibility !== 'lab' && !body.force) {
      return fail(
        'subject_not_published',
        `${refOfRow(task) ?? params.ref} belongs to ${subject.ref}, which is ${subject.visibility}: Cairn would show ` +
          `it to everyone there. Publish ${subject.ref} first (croft subject publish ${subject.ref}), or push ` +
          `anyway with --force.`,
        { subject: subject.ref, visibility: subject.visibility },
      )
    }

    const linked = await linkTodoToCairn(
      actor,
      { id: task.id, ref: refOfRow(task) ?? params.ref, subject_id: (task.subject_id as string | null) ?? null },
      { cairnRef: body.cairnRef, cairnStatus: body.cairnStatus, cairnResolution: body.cairnResolution, cairnResolutionKind: body.cairnResolutionKind },
    )
    return ok(linked)
  },
})

import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { findTask, refOfRow, refuseArchived, subjectOfTask } from '@/lib/api/tasks'
import { linkHandoff } from '@/lib/api/handoff'
import { handoffOf } from '@/lib/api/handoff-shape'
import { cairnLinkSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/**
 * Deprecated (0.7): `POST /tasks/{ref}/handoff` with tracker `cairn`. Kept so
 * 0.6 CLIs keep working; removed in 0.8.
 */
export const POST = route<{ ref: string }, z.infer<typeof cairnLinkSchema>>({
  schema: cairnLinkSchema,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, 'id, number, subject_id, handoff_tracker, handoff_ref, project:projects!project_id!inner(key, status)')
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    const taskRef = refOfRow(task) ?? params.ref
    // A 0.6 CLI only knows Cairn links: it must not overwrite another tracker's.
    const current = handoffOf(task)
    if (current && current.tracker !== 'cairn') {
      return fail(
        'conflict',
        `${taskRef} is handed off to ${current.tracker} as ${current.ref}. Update the CLI (0.7: croft handoff) to change it.`,
        { handoff: current },
      )
    }
    const refresh = current !== null && current.ref === body.cairnRef
    const subject = refresh ? null : await subjectOfTask(task.subject_id, actor.userId)
    if (subject && subject.visibility !== 'lab' && !body.force) {
      return fail(
        'subject_not_published',
        `${taskRef} belongs to ${subject.ref}, which is ${subject.visibility}: cairn has no notion of who may ` +
          `see what, so it would show it to everyone there. Publish ${subject.ref} first ` +
          `(croft subject publish ${subject.ref}), or push anyway with --force.`,
        { subject: subject.ref, visibility: subject.visibility },
      )
    }

    const linked = await linkHandoff(
      actor,
      { id: task.id, ref: taskRef, subject_id: (task.subject_id as string | null) ?? null },
      {
        tracker: 'cairn',
        ref: body.cairnRef,
        status: body.cairnStatus,
        resolution: body.cairnResolution,
        resolutionKind: body.cairnResolutionKind,
      },
    )
    return ok(linked)
  },
})

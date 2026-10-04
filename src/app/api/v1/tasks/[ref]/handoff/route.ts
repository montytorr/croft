import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { findTask, refOfRow, refuseArchived, subjectOfTask, TASK_FIELDS } from '@/lib/api/tasks'
import { linkHandoff, unlinkHandoff } from '@/lib/api/handoff'
import { handoffOf } from '@/lib/api/handoff-shape'
import { withAssignee } from '@/lib/api/people'
import { withoutHiddenLinks } from '@/lib/api/visibility'
import { handoffSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

const taskForHandoff = 'id, number, subject_id, handoff_tracker, handoff_ref, project:projects!project_id!inner(key, status)'

/**
 * Records that `croft handoff` filed this todo in another tracker, or re-links
 * it (overwrite). Written after the task exists there, so the link never points
 * at nothing. With a done or cancelled `status` it also applies the outcome,
 * once: the subject's log gets `<ref> done: <resolution>` and the todo is
 * closed. That is the one path that closes a handed-off todo.
 */
export const POST = route<{ ref: string }, z.infer<typeof handoffSchema>>({
  schema: handoffSchema,
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref, taskForHandoff)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    const taskRef = refOfRow(task) ?? params.ref
    const tracker = body.tracker as string

    // A tracker has no notion of who may see what: a todo of a private or
    // members-only subject leaves for it only when the caller says so. A
    // status refresh of the link it already has is not leaving again.
    const current = handoffOf(task)
    const refresh = current !== null && current.tracker === tracker && current.ref === body.ref
    const subject = refresh ? null : await subjectOfTask(task.subject_id, actor.userId)
    if (subject && subject.visibility !== 'lab' && !body.force) {
      return fail(
        'subject_not_published',
        `${taskRef} belongs to ${subject.ref}, which is ${subject.visibility}: ${tracker} has no notion of who ` +
          `may see what, so it would show it to everyone there. Publish ${subject.ref} first ` +
          `(croft subject publish ${subject.ref}), or hand it off anyway with --force.`,
        { subject: subject.ref, visibility: subject.visibility },
      )
    }

    const linked = await linkHandoff(
      actor,
      { id: task.id, ref: taskRef, subject_id: (task.subject_id as string | null) ?? null },
      {
        tracker,
        ref: body.ref,
        url: body.url,
        status: body.status,
        resolution: body.resolution,
        resolutionKind: body.resolutionKind,
      },
    )
    return ok(linked)
  },
})

/**
 * Takes a hand-off back: clears the link and writes `T-41 taken back from
 * <tracker> (<ref>)` on the subject. Nothing is done in the other tracker.
 * Returns the todo.
 */
export const DELETE = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, taskForHandoff)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    const taskRef = refOfRow(task) ?? params.ref
    if (!handoffOf(task)) return fail('conflict', `${taskRef} is not handed off.`)

    await unlinkHandoff(actor, { id: task.id, ref: taskRef, subject_id: (task.subject_id as string | null) ?? null })

    const todo = await findTask(actor, params.ref, TASK_FIELDS)
    if (!todo) return fail('not_found', `No task ${params.ref}.`)
    return ok(await withoutHiddenLinks(await withAssignee(todo), actor.userId))
  },
})

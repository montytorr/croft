import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { deleteSubject, noSuchSubject, refuseSubjectDelete, resolveSubject, updateSubject } from '@/lib/api/subjects'
import { updateSubjectSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** `S-12`, `12` or the subject's id. */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    return ok(subject)
  },
})

/**
 * Edits a subject. Moving it into a completed or dropped stage without a
 * conclusion (already recorded, or sent with the move) is refused with
 * `conclusion_required`. Every stage change writes a `stage` note.
 *
 * `visibility` (owner only): `private ↔ members` freely, either → `lab` for
 * good; `lab →` anything else is `already_published`. A non-lab subject with
 * no owner is `owner_required`. Each change writes a `visibility` note.
 */
export const PATCH = route<{ ref: string }, z.infer<typeof updateSubjectSchema>>({
  schema: updateSubjectSchema,
  secretFields: ['title', 'body', 'conclusion'],
  handler: async ({ actor, params, body }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    const updated = await updateSubject(actor, subject, body)
    if (!updated.ok) return updated.response
    return ok(updated.value)
  },
})

/**
 * Deletes a subject for good, with its todos, log, notes and files. The owner
 * may; an administrator may only for a subject in the lab. The ref is
 * repeated to confirm (`?confirm=S-12`), as for a task: nothing comes back.
 */
export const DELETE = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    // A caller who may not delete it is refused before being asked to confirm.
    const refused = refuseSubjectDelete(subject, actor)
    if (refused) return refused
    if ((url.searchParams.get('confirm') ?? '').toUpperCase() !== subject.ref) {
      return fail(
        'validation_failed',
        `This permanently deletes ${subject.ref}, its todos, its log and its files, and cannot be undone. ` +
          `Repeat the ref to confirm: ?confirm=${subject.ref}`,
        { requiresConfirmation: subject.ref },
      )
    }
    const deleted = await deleteSubject(actor, subject)
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})

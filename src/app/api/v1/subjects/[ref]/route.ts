import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { noSuchSubject, resolveSubject, updateSubject } from '@/lib/api/subjects'
import { updateSubjectSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** `S-12`, `12` or the subject's id. */
export const GET = route<{ ref: string }>({
  handler: async ({ params }) => {
    const subject = await resolveSubject(params.ref)
    if (!subject) return noSuchSubject(params.ref)
    return ok(subject)
  },
})

/**
 * Edits a subject. Moving it into a completed or dropped stage without a
 * conclusion (already recorded, or sent with the move) is refused with
 * `conclusion_required`. Every stage change writes a `stage` note.
 */
export const PATCH = route<{ ref: string }, z.infer<typeof updateSubjectSchema>>({
  schema: updateSubjectSchema,
  secretFields: ['title', 'body', 'conclusion'],
  handler: async ({ actor, params, body }) => {
    const subject = await resolveSubject(params.ref)
    if (!subject) return noSuchSubject(params.ref)
    const updated = await updateSubject(actor, subject, body)
    if (!updated.ok) return updated.response
    return ok(updated.value)
  },
})

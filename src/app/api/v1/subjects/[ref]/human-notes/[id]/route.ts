import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { noSuchSubject, resolveSubject } from '@/lib/api/subjects'
import { deleteSubjectHumanNote, refuseUnreadableNote, updateSubjectHumanNote } from '@/lib/api/human-notes'
import { subjectHumanNoteSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** Rewrites a note. Its author only: `forbidden` for anyone else, administrators included. */
export const PATCH = route<{ ref: string; id: string }, z.infer<typeof subjectHumanNoteSchema>>({
  schema: subjectHumanNoteSchema,
  secretFields: ['body'],
  handler: async ({ actor, params, body }) => {
    const subject = await resolveSubject(params.ref)
    if (!subject) return noSuchSubject(params.ref)
    const unreadable = refuseUnreadableNote(actor, body.body)
    if (unreadable) return unreadable
    const updated = await updateSubjectHumanNote(actor, subject.id, params.id, body.body)
    return updated.ok ? ok(updated.note) : updated.response
  },
})

/** Removes a note. Its author, or an administrator. */
export const DELETE = route<{ ref: string; id: string }>({
  handler: async ({ actor, params }) => {
    const subject = await resolveSubject(params.ref)
    if (!subject) return noSuchSubject(params.ref)
    const deleted = await deleteSubjectHumanNote(actor, subject.id, params.id)
    return deleted.ok ? ok({ deleted: true, id: params.id }) : deleted.response
  },
})

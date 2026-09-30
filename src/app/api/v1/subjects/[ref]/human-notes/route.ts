import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { noSuchSubject, resolveSubject } from '@/lib/api/subjects'
import { addSubjectHumanNote, listSubjectHumanNotes, refuseUnreadableNote } from '@/lib/api/human-notes'
import { subjectHumanNoteSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** People's notes on the subject, newest first. Anyone may read them, agents included. */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    return ok(await listSubjectHumanNotes(subject.id))
  },
})

/**
 * Adds a note. Any member may write one; an agent's is attributed to its
 * human, who can then edit or delete it from the board.
 */
export const POST = route<{ ref: string }, z.infer<typeof subjectHumanNoteSchema>>({
  schema: subjectHumanNoteSchema,
  secretFields: ['body'],
  handler: async ({ actor, params, body }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    const unreadable = refuseUnreadableNote(actor, body.body)
    if (unreadable) return unreadable
    return ok(await addSubjectHumanNote(actor, subject.id, body.body), { status: 201 })
  },
})

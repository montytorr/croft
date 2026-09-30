import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { addSubjectNote, listSubjectNotes, noSuchSubject, resolveSubject } from '@/lib/api/subjects'
import { SUBJECT_NOTE_KINDS, type SubjectNoteKind } from '@/lib/lab/types'
import { createSubjectNoteSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** The work log, newest first. `?kind=` narrows it. */
export const GET = route<{ ref: string }>({
  handler: async ({ params, url }) => {
    const subject = await resolveSubject(params.ref)
    if (!subject) return noSuchSubject(params.ref)

    const kind = url.searchParams.get('kind')
    if (kind && !(SUBJECT_NOTE_KINDS as readonly string[]).includes(kind)) {
      return fail('validation_failed', `Unknown kind. Valid: ${SUBJECT_NOTE_KINDS.join(' | ')}.`)
    }
    return ok(await listSubjectNotes(subject.id, { kind: (kind as SubjectNoteKind | null) ?? undefined }))
  },
})

/**
 * Appends to the log. Idempotent on (subject, kind + text): a retry answers
 * 200 `{duplicate: true}` instead of writing the note twice.
 */
export const POST = route<{ ref: string }, z.infer<typeof createSubjectNoteSchema>>({
  schema: createSubjectNoteSchema,
  secretFields: ['note'],
  handler: async ({ actor, params, body }) => {
    const subject = await resolveSubject(params.ref)
    if (!subject) return noSuchSubject(params.ref)
    const { note } = await addSubjectNote(actor, subject.id, body)
    return note ? ok(note, { status: 201 }) : ok({ duplicate: true })
  },
})

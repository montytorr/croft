import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { addSubjectMember, noSuchSubject, resolveSubject } from '@/lib/api/subjects'
import { subjectMemberSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** Who the subject is shared with (the owner is not listed). Anyone who can see the subject may ask. */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    return ok({ ref: subject.ref, visibility: subject.visibility, owner: subject.owner, members: subject.members })
  },
})

/**
 * Shares the subject with one more person (`user`: `me`, an id, an email or a
 * name). Owner only. A private subject becomes a `members` one; a lab subject
 * is refused with `already_published` — everyone sees it already.
 */
export const POST = route<{ ref: string }, z.infer<typeof subjectMemberSchema>>({
  schema: subjectMemberSchema,
  handler: async ({ actor, params, body }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    const added = await addSubjectMember(actor, subject, body.user)
    return added.ok ? ok(added.value, { status: 201 }) : added.response
  },
})

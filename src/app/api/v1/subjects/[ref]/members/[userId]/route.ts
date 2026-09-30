import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { noSuchSubject, removeSubjectMember, resolveSubject } from '@/lib/api/subjects'

export const dynamic = 'force-dynamic'

/**
 * Stops sharing the subject with someone (an id, `me`, an email or a name).
 * The owner removes anybody; a member may remove themselves. Signed file links
 * already handed out stay valid for up to an hour.
 */
export const DELETE = route<{ ref: string; userId: string }>({
  handler: async ({ actor, params }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    const removed = await removeSubjectMember(actor, subject, params.userId)
    return removed.ok ? ok(removed.value) : removed.response
  },
})

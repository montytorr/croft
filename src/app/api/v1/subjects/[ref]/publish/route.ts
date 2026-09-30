import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { noSuchSubject, publishSubject, resolveSubject } from '@/lib/api/subjects'

export const dynamic = 'force-dynamic'

/**
 * Publishes a private or members subject to the lab, for good: everyone can
 * see it and its todos from now on, and it cannot be made private again
 * (`already_published`). Owner only. Writes a `visibility` note.
 */
export const POST = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    const published = await publishSubject(actor, subject)
    return published.ok ? ok(published.value) : published.response
  },
})

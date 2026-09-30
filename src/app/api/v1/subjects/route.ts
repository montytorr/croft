import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { resolveAssignee } from '@/lib/api/people'
import { createSubject, listSubjects } from '@/lib/api/subjects'
import { createSubjectSchema, listSubjectsQuery } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/**
 * The board, as a list: lanes in order, then each lane's own order.
 * `owner` is `me`, a user id, an email or a display name.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const parsed = listSubjectsQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return fail('validation_failed', 'Bad query parameters.', { issues: parsed.error.issues })
    const { stage, tag, owner, q, archived } = parsed.data

    let ownerId: string | undefined
    if (owner) {
      const person = await resolveAssignee(owner, actor.userId)
      if (!person.ok) return fail(person.code, person.error)
      ownerId = person.person.id
    }

    return ok(await listSubjects({ stage, tag, ownerId, q, archived }))
  },
})

export const POST = route<Record<string, string>, z.infer<typeof createSubjectSchema>>({
  schema: createSubjectSchema,
  secretFields: ['title', 'body', 'conclusion'],
  handler: async ({ actor, body }) => {
    const created = await createSubject(actor, body)
    if (!created.ok) return created.response
    return ok(created.value, { status: 201 })
  },
})

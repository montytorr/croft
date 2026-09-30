import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { createSubjectTodo, listSubjectTodos, noSuchSubject, resolveSubject } from '@/lib/api/subjects'
import { createSubjectTodoSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** The subject's todos — tasks in project T — open ones first. */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    return ok(await listSubjectTodos(subject.id))
  },
})

/**
 * Files a todo: a task in project T (created on first use) pointed at this
 * subject. Every task verb works on its `T-n` ref.
 */
export const POST = route<{ ref: string }, z.infer<typeof createSubjectTodoSchema>>({
  schema: createSubjectTodoSchema,
  secretFields: ['title', 'description'],
  handler: async ({ actor, params, body }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    const created = await createSubjectTodo(actor, subject, body)
    if (!created.ok) return created.response
    return ok(created.value, { status: 201 })
  },
})

import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { noSuchSubject, resolveSubject } from '@/lib/api/subjects'
import { addSubjectAttachment, listSubjectAttachments } from '@/lib/api/subject-attachments'

export const dynamic = 'force-dynamic'

/** The subject's files, oldest first, each with fresh signed links and its stable `content_url`. */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)
    return ok(await listSubjectAttachments(subject.id))
  },
})

/**
 * multipart/form-data with a `file` field. The same allowlist and size limit
 * as a task's files; HTML is accepted and only ever served sandboxed.
 * Answers the `Attachment`, whose `content_url` is what markdown embeds.
 */
export const POST = route<{ ref: string }>({
  handler: async ({ actor, params, req }) => {
    const subject = await resolveSubject(params.ref, actor.userId)
    if (!subject) return noSuchSubject(params.ref)

    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) {
      return fail('validation_failed', 'Send multipart/form-data with a "file" field.')
    }

    const added = await addSubjectAttachment(actor, subject.id, file)
    return added.ok ? ok(added.value, { status: 201 }) : added.response
  },
})

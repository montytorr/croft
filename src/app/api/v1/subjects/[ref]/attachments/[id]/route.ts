import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { noSuchSubject, resolveSubject } from '@/lib/api/subjects'
import { deleteSubjectAttachment } from '@/lib/api/subject-attachments'

export const dynamic = 'force-dynamic'

/** Removes a file from the subject, bytes first. Any member, as for a task's files. */
export const DELETE = route<{ ref: string; id: string }>({
  handler: async ({ params }) => {
    const subject = await resolveSubject(params.ref)
    if (!subject) return noSuchSubject(params.ref)
    const deleted = await deleteSubjectAttachment(subject.id, params.id)
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})

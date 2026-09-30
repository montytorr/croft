import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { deleteTag, refuseNonAdmin, updateTag } from '@/lib/api/lab-admin'
import { updateTagSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

export const PATCH = route<{ id: string }, z.infer<typeof updateTagSchema>>({
  schema: updateTagSchema,
  handler: async ({ actor, params, body }) => {
    const refused = refuseNonAdmin(actor, 'the tags')
    if (refused) return refused
    const updated = await updateTag(params.id, body)
    return updated.ok ? ok(updated.value) : updated.response
  },
})

/** Takes the tag off every subject that carried it; says how many. */
export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const refused = refuseNonAdmin(actor, 'the tags')
    if (refused) return refused
    const deleted = await deleteTag(params.id)
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})

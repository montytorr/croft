import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { deleteLabProject, refuseNonAdmin, updateLabProject } from '@/lib/api/lab-admin'
import { updateLabProjectSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** `cairnKey: null` (or `""`) clears the key; an omitted field is left as it is. */
export const PATCH = route<{ id: string }, z.infer<typeof updateLabProjectSchema>>({
  schema: updateLabProjectSchema,
  handler: async ({ actor, params, body }) => {
    const refused = refuseNonAdmin(actor, 'the lab projects')
    if (refused) return refused
    const updated = await updateLabProject(params.id, body)
    return updated.ok ? ok(updated.value) : updated.response
  },
})

/** Refused with `project_in_use` while any subject, archived or not, is in it. */
export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const refused = refuseNonAdmin(actor, 'the lab projects')
    if (refused) return refused
    const deleted = await deleteLabProject(params.id)
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})

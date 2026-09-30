import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { deleteStage, refuseNonAdmin, updateStage } from '@/lib/api/lab-admin'
import { updateStageSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

export const PATCH = route<{ id: string }, z.infer<typeof updateStageSchema>>({
  schema: updateStageSchema,
  handler: async ({ actor, params, body }) => {
    const refused = refuseNonAdmin(actor, 'the stages')
    if (refused) return refused
    const updated = await updateStage(params.id, body)
    return updated.ok ? ok(updated.value) : updated.response
  },
})

/** Refused with `stage_in_use` while any subject, archived or not, is in it. */
export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const refused = refuseNonAdmin(actor, 'the stages')
    if (refused) return refused
    const deleted = await deleteStage(params.id)
    return deleted.ok ? ok(deleted.value) : deleted.response
  },
})

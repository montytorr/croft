import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { refuseNonAdmin, reorderStages } from '@/lib/api/lab-admin'
import { reorderSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** `ids` names every stage once, in the new order. Returns the stages. */
export const POST = route<Record<string, string>, z.infer<typeof reorderSchema>>({
  schema: reorderSchema,
  handler: async ({ actor, body }) => {
    const refused = refuseNonAdmin(actor, 'the stages')
    if (refused) return refused
    const reordered = await reorderStages(body.ids)
    return reordered.ok ? ok(reordered.value) : reordered.response
  },
})

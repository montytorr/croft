import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { createStage, listStages, refuseNonAdmin } from '@/lib/api/lab-admin'
import { createStageSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

export const GET = route({ handler: async () => ok(await listStages()) })

/** Adds a lane. Administrators only; without `position` it goes last. */
export const POST = route<Record<string, string>, z.infer<typeof createStageSchema>>({
  schema: createStageSchema,
  handler: async ({ actor, body }) => {
    const refused = refuseNonAdmin(actor, 'the stages')
    if (refused) return refused
    const created = await createStage(body)
    return created.ok ? ok(created.value, { status: 201 }) : created.response
  },
})

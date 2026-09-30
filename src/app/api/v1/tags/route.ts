import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { createTag, listTags, refuseNonAdmin } from '@/lib/api/lab-admin'
import { createTagSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

export const GET = route({ handler: async () => ok(await listTags()) })

/** Tags are curated: administrators add them, everyone applies them. Names are stored lower-case. */
export const POST = route<Record<string, string>, z.infer<typeof createTagSchema>>({
  schema: createTagSchema,
  handler: async ({ actor, body }) => {
    const refused = refuseNonAdmin(actor, 'the tags')
    if (refused) return refused
    const created = await createTag(body)
    return created.ok ? ok(created.value, { status: 201 }) : created.response
  },
})

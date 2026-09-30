import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { createLabProject, listLabProjects, refuseNonAdmin } from '@/lib/api/lab-admin'
import { createLabProjectSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** In order, each with how many subjects (archived ones included) are in it. */
export const GET = route({ handler: async () => ok(await listLabProjects()) })

/** Lab projects are curated: administrators add them, everyone files subjects under them. */
export const POST = route<Record<string, string>, z.infer<typeof createLabProjectSchema>>({
  schema: createLabProjectSchema,
  handler: async ({ actor, body }) => {
    const refused = refuseNonAdmin(actor, 'the lab projects')
    if (refused) return refused
    const created = await createLabProject(body)
    return created.ok ? ok(created.value, { status: 201 }) : created.response
  },
})

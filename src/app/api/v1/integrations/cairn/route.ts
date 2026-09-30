import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { canAdministerUsers } from '@/lib/api/actor'
import { isLabAdmin } from '@/lib/api/lab-admin'
import { getCairnConnection, saveCairnConnection } from '@/lib/api/cairn-link'
import { cairnConnectionSchema } from '@/schemas/subject'

export const dynamic = 'force-dynamic'

/** Where Cairn is and whether a key is set. Never the key. Administrators only. */
export const GET = route({
  handler: async ({ actor }) => {
    if (!isLabAdmin(actor)) return fail('forbidden', 'Only an administrator can see the Cairn connection.')
    return ok(await getCairnConnection())
  },
})

/**
 * Connects this instance to a Cairn. A signed-in administrator only, like the
 * branding: the key is a credential for another system, and an agent key has
 * no business setting one. `apiKey` omitted keeps the stored key.
 */
export const PUT = route<Record<string, string>, z.infer<typeof cairnConnectionSchema>>({
  schema: cairnConnectionSchema,
  handler: async ({ actor, body }) => {
    if (!canAdministerUsers(actor)) {
      return fail('forbidden', 'Only a signed-in administrator can change the Cairn connection.')
    }
    return ok(await saveCairnConnection(actor, body))
  },
})

import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { createUserKey, listUserKeys } from '@/lib/api/users'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'

const createKeySchema = z.object({
  agentName: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(100),
})

export const GET = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await listUserKeys(params.id))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})

/**
 * Minting a key for someone else is refused, administrators included. A key is
 * its holder's identity: whoever holds a person's key reads everything that
 * person can see, their private subjects too, so an administrator who could
 * mint one could read anyone's private work. People pair their own keys
 * (`croft setup`, approved in their own browser); an administrator can still
 * list and revoke anyone's keys, which only ever takes access away.
 */
export const POST = route<{ id: string }, z.infer<typeof createKeySchema>>({
  schema: createKeySchema,
  handler: async ({ actor, params, body }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    if (params.id !== actor.userId) {
      return fail(
        'forbidden',
        'Keys are paired by the person who holds them: they run `croft setup` and approve it in their own browser. An administrator can list and revoke keys, not mint them for someone else.',
      )
    }
    try {
      return ok(await createUserKey(params.id, body), { status: 201 })
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})

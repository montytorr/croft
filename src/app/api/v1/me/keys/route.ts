import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { listOwnKeys } from '@/lib/api/own-keys'
import { requireOwnKeysHuman } from '@/lib/api/own-keys-route'

/**
 * The signed-in person's own agent keys (CROFT-315): what pairing minted for
 * them, so a retired or lost machine can be cut off without an administrator.
 * Human browser session only — see `requireOwnKeysHuman`.
 */
export const GET = route({
  handler: async ({ actor }) => {
    const denied = requireOwnKeysHuman(actor)
    if (denied) return denied
    return ok(await listOwnKeys(actor.userId))
  },
})

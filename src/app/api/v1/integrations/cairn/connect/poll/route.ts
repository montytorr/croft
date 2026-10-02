import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { CairnPairingError, pollCairnPairing } from '@/lib/api/cairn-pairing'

export const dynamic = 'force-dynamic'

export const POST = route({
  schema: z.object({ token: z.string().min(1).max(5000) }),
  handler: async ({ actor, body }) => {
    try { return ok(await pollCairnPairing(actor, body.token)) } catch (error) {
      if (error instanceof CairnPairingError) return fail(error.code, error.message)
      throw error
    }
  },
})

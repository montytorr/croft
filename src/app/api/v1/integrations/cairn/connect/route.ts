import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { CairnPairingError, startCairnPairing } from '@/lib/api/cairn-pairing'

export const dynamic = 'force-dynamic'

export const POST = route({
  schema: z.object({ url: z.string().trim().min(1).max(1000) }),
  handler: async ({ actor, body }) => {
    try { return ok(await startCairnPairing(actor, body.url)) } catch (error) {
      if (error instanceof CairnPairingError) return fail(error.code, error.message)
      throw error
    }
  },
})

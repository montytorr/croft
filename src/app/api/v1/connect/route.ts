import { z } from 'zod'
import { addressLimiter } from '@/lib/api/address-limiter'
import { clientAddress } from '@/lib/api/client-address'
import { createConnectRequest, RUNTIME_PATTERN } from '@/lib/api/connect'
import { servedOrigin } from '@/lib/api/handler'
import { fail, failValidation, ok } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  // A hostname, as `hostOf` in auth.ts accepts one. The approval card shows it
  // and the key's name carries it, so it may not smuggle in bidi overrides,
  // newlines or a name dressed up to look like someone else's machine.
  host: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/),
  runtimes: z.array(z.string().regex(RUNTIME_PATTERN)).min(1).max(6),
  cliVersion: z.string().trim().min(1).max(100).optional(),
})

/**
 * A machine with no credentials asks for some, the same shape as OAuth 2.0's
 * device authorization grant. `route()` always requires an actor, so this
 * bypasses it — the same way /api/auth/login and /api/v1/health do — and is
 * the one endpoint in this file whose job is to be reachable without one.
 */
const limiter = addressLimiter({ windowMs: 10 * 60_000, max: 10 })

export const POST = async (req: Request): Promise<Response> => {
  const address = clientAddress(req.headers)
  if (limiter.hit(address)) {
    return fail('rate_limited', 'Too many pairing requests from this address. Try again later.', {
      retryAfter: limiter.retryAfterSeconds,
    })
  }

  const raw = await req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return failValidation(parsed.error.issues)

  try {
    // CROFT_BASE_URL first, same variable the CLI and layout.tsx already use
    // for "the public URL of this instance" — it is the only correct answer
    // behind a reverse proxy with no public hostname of its own to report.
    // Falling back to the request's served origin (the same origin CSRF
    // protection trusts, in handler.ts) covers a bare local/dev deployment.
    const baseUrl = (process.env.CROFT_BASE_URL || servedOrigin(req)).replace(/\/+$/, '')
    const created = await createConnectRequest({
      host: parsed.data.host,
      runtimes: [...new Set(parsed.data.runtimes)],
      cliVersion: parsed.data.cliVersion,
      clientAddress: address,
      baseUrl,
    })
    return ok(created, { status: 201 })
  } catch (error) {
    console.error('[api] connect create failed', error)
    return fail('internal_error', 'Something went wrong.')
  }
}

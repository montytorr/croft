import { NextResponse } from 'next/server'
import { z } from 'zod'
import { addressLimiter } from '@/lib/api/address-limiter'
import { clientAddress } from '@/lib/api/client-address'
import { isTrustedMutationOrigin } from '@/lib/api/handler'
import { consumePasswordReset, INVALID_RESET_LINK } from '@/lib/api/password-reset'
import { fail } from '@/lib/api/response'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  password: z.string().min(12).max(1024),
})

const perAddress = addressLimiter({ windowMs: 15 * 60_000, max: 10 })

/**
 * Redeems a reset link from /reset/<token>: sets the password, spends the
 * token, and signs the person out everywhere. A token that is unknown, used,
 * expired or superseded gets one answer, 400 `invalid_token`, whatever the
 * reason. Limited per client address, so the endpoint is no oracle for
 * guessing tokens (which are 256 random bits in any case).
 */
export const POST = async (req: Request): Promise<Response> => {
  if (!isTrustedMutationOrigin(req)) return fail('forbidden', 'Browser requests must come from the Croft origin.')
  if (perAddress.hit(clientAddress(req.headers))) {
    return fail('rate_limited', 'Too many attempts from this address. Try again later.', {
      retryAfter: perAddress.retryAfterSeconds,
    })
  }
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    const tokenOk = bodySchema.shape.token.safeParse(raw?.token).success
    return tokenOk
      ? fail('validation_failed', 'Password must be at least 12 characters.')
      : fail('invalid_token', INVALID_RESET_LINK)
  }
  if (!(await consumePasswordReset(parsed.data.token, parsed.data.password))) {
    return fail('invalid_token', INVALID_RESET_LINK)
  }
  return NextResponse.json({ ok: true })
}

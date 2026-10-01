import { NextResponse } from 'next/server'
import { z } from 'zod'
import { addressLimiter } from '@/lib/api/address-limiter'
import { clientAddress } from '@/lib/api/client-address'
import { isTrustedMutationOrigin } from '@/lib/api/handler'
import { sendForgotPasswordReset } from '@/lib/api/password-reset'
import { fail } from '@/lib/api/response'
import { mailConfigurationProblem } from '@/lib/mail'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ email: z.string().trim().email().max(320) })

const perAddress = addressLimiter({ windowMs: 15 * 60_000, max: 5 })
const perAccount = addressLimiter({ windowMs: 60 * 60_000, max: 3 })

/**
 * "Forgot your password?" on the sign-in page. The answer is `{ ok: true }`
 * whether or not the email belongs to anyone, and the lookup and the send run
 * after it, so neither the body nor the timing says which. Limited per client
 * address (429, which says nothing about any account) and per email address,
 * silently: past the limit the same `{ ok: true }` comes back and nothing is
 * sent, so the form cannot be used to flood someone's inbox.
 *
 * 503 `mail_not_configured` when this Croft cannot send mail at all — the
 * same for every address, and the sign-in page does not offer the form then.
 */
export const POST = async (req: Request): Promise<Response> => {
  if (!isTrustedMutationOrigin(req)) return fail('forbidden', 'Browser requests must come from the Croft origin.')
  if (perAddress.hit(clientAddress(req.headers))) {
    return fail('rate_limited', 'Too many requests from this address. Try again later.', {
      retryAfter: perAddress.retryAfterSeconds,
    })
  }
  const problem = mailConfigurationProblem()
  if (problem) return fail('mail_not_configured', problem)

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return fail('validation_failed', 'Enter the email address you sign in with.')

  if (!perAccount.hit(parsed.data.email.toLowerCase())) {
    void sendForgotPasswordReset(parsed.data.email).catch((error: unknown) => {
      console.error('[auth] forgot-password failed', error instanceof Error ? error.message : error)
    })
  }
  return NextResponse.json({ ok: true })
}

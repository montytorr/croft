import { route } from '@/lib/api/handler'
import { addressLimiter } from '@/lib/api/address-limiter'
import { PasswordResetError, sendAdminPasswordReset } from '@/lib/api/password-reset'
import { fail, ok } from '@/lib/api/response'
import { requireUserAdministrator } from '@/lib/api/user-admin-route'
import { mailConfigurationProblem } from '@/lib/mail'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Per person, so a slip of the button cannot flood their inbox. */
const perUser = addressLimiter({ windowMs: 15 * 60_000, max: 5 })

/**
 * An administrator has a single-use reset link emailed to the person. That is
 * all the role can do about someone's password: it never sees a password, a
 * token or the link, and the answer says only where the mail went, masked.
 * Human administrator session only (`requireUserAdministrator`).
 *
 * 503 `mail_not_configured` (and nothing created) when this Croft cannot send
 * mail; 502 `mail_send_failed` when Resend refuses or does not answer, with
 * the link already invalidated.
 */
export const POST = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    const problem = mailConfigurationProblem()
    if (problem) return fail('mail_not_configured', problem)
    if (!UUID.test(params.id)) return fail('not_found', 'No such user.')
    if (perUser.hit(params.id.toLowerCase())) {
      return fail('rate_limited', 'Several reset links were sent to this person just now. Try again later.', {
        retryAfter: perUser.retryAfterSeconds,
      })
    }
    try {
      return ok(await sendAdminPasswordReset(params.id, actor))
    } catch (error) {
      if (error instanceof PasswordResetError) return fail(error.code, error.message)
      throw error
    }
  },
})

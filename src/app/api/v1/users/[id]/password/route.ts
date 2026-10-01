import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { resetUserPassword } from '@/lib/api/users'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'

const passwordSchema = z.object({ password: z.string().min(12).max(1024) })

/**
 * Nobody sets anyone else's password, administrators included (v0.5): a
 * password an administrator chose is one they know, and so a way to sign in
 * as that person and read their private subjects. An administrator sends a
 * reset link instead (`POST /users/{id}/password-reset`), which only the
 * person receives. Your own id still works here, as it does in Settings.
 */
export const POST = route<{ id: string }, z.infer<typeof passwordSchema>>({
  schema: passwordSchema,
  handler: async ({ actor, params, body }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    if (params.id !== actor.userId) {
      return fail(
        'forbidden',
        "An administrator cannot set someone else's password. Send them a reset link instead " +
          '(POST /api/v1/users/{id}/password-reset): it goes to their email, and only they see it.',
      )
    }
    try {
      await resetUserPassword(params.id, body.password)
      return ok({ reset: true, sessionsRevoked: true })
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})

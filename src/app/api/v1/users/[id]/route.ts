import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { failValidation, ok } from '@/lib/api/response'
import { USER_ROLES } from '@/lib/api/actor'
import { deactivateUser, updateUser } from '@/lib/api/users'
import { requireUserAdministrator, userAdminFailure } from '@/lib/api/user-admin-route'

export const dynamic = 'force-dynamic'

const updateUserSchema = z.object({
  email: z.string().email().max(320).optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
  role: z.enum(USER_ROLES).optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required.')

export const PATCH = route<{ id: string }, z.infer<typeof updateUserSchema>>({
  schema: updateUserSchema,
  handler: async ({ actor, params, body }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    try {
      return ok(await updateUser(params.id, body))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})

const deactivateUserSchema = z.object({
  reassignTo: z.string().uuid().optional(),
})

/**
 * `reassignTo` names who takes over the user's open tasks (CROFT-310). The
 * handler wrapper reads no body on DELETE, so it is read here, and the query
 * string is accepted too for a client that cannot send a body on a DELETE.
 */
export const DELETE = route<{ id: string }>({
  handler: async ({ actor, params, req, url }) => {
    const denied = requireUserAdministrator(actor)
    if (denied) return denied
    const raw = await req.json().catch(() => ({})) as Record<string, unknown> | null
    const parsed = deactivateUserSchema.safeParse({
      reassignTo: raw?.reassignTo ?? url.searchParams.get('reassignTo') ?? undefined,
    })
    if (!parsed.success) return failValidation(parsed.error.issues)
    try {
      return ok(await deactivateUser(params.id, { by: actor, reassignTo: parsed.data.reassignTo }))
    } catch (error) {
      return userAdminFailure(error)
    }
  },
})

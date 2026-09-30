import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { syncCairn } from '@/lib/api/cairn-link'

export const dynamic = 'force-dynamic'

/**
 * Reads every pushed todo's Cairn task back: records its status and, the
 * first time Cairn reports it done or cancelled, writes the outcome into the
 * subject's log. Open to any member — it reveals nothing and uses the stored
 * key server-side. One unreachable Cairn task is reported, not fatal.
 */
export const POST = route({
  handler: async ({ actor }) => {
    const synced = await syncCairn(actor)
    if (!synced.ok) {
      return fail('conflict', 'Cairn is not connected. An administrator can connect it in Settings.', {
        reason: synced.reason,
      })
    }
    return ok(synced.report)
  },
})

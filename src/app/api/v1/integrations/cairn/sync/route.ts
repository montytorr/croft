import { route } from '@/lib/api/handler'
import { fail, ok } from '@/lib/api/response'
import { syncCairn } from '@/lib/api/cairn-link'

export const dynamic = 'force-dynamic'

/**
 * Reads every pushed todo's Cairn task back: records its status and, the
 * first time Cairn reports it done or cancelled, writes the outcome into the
 * subject's log. Open to any member — it reveals nothing and uses the stored
 * key server-side. One unreachable Cairn task is reported, not fatal.
 *
 * A Cairn task that ended also closes its todo here (Cairn owns a todo's
 * status once it is pushed). `results` is one line per todo, for printing.
 */
export const POST = route({
  handler: async ({ actor }) => {
    const synced = await syncCairn(actor)
    if (!synced.ok) {
      // Its own code, not `conflict`: `croft sync` reads it as "sync through
      // this machine's cairn CLI instead", which no other 409 means.
      return fail(
        'cairn_not_configured',
        synced.reason === 'key_unreadable'
          ? 'The stored Cairn key cannot be decrypted with this instance\'s CROFT_SECRET_KEY. ' +
              'An administrator can enter it again in Settings.'
          : 'Cairn is not connected. An administrator can connect it in Settings.',
        { reason: synced.reason },
      )
    }
    return ok(synced.report)
  },
})

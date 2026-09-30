import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { assess, readVitals } from '@/lib/api/vitals'

export const dynamic = 'force-dynamic'

/**
 * Is the memory still being written, and is any of it read?
 *
 * Distinct from `/health`, which reports on the process and reported itself
 * healthy throughout two days of recording nothing.
 *
 * The second half of that question was answerable and unasked here. Everything
 * that writes knowledge into Croft is an agent, and every number about whether
 * agents consult it reached exactly one reader: a person who opened the Vitals
 * page in a browser. So `memory` rides along with the counts — same window,
 * same call — for the same reason knowledge/gaps exists. See CROFT-254.
 */
export const GET = route({
  handler: async ({ actor, url }) => {
    const requested = Number(url.searchParams.get('hours'))
    const hours = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 720) : 24

    const report = await readVitals(actor, hours)
    return ok({ ...report, findings: assess(report) })
  },
})

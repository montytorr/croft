import { route } from '@/lib/api/handler'
import { ok } from '@/lib/api/response'
import { subjectBrief } from '@/lib/api/subjects'

export const dynamic = 'force-dynamic'

/**
 * The lab block of a session briefing: how many subjects sit in each stage,
 * and up to three live ones the caller's human owns, active before planned.
 * Nothing narrows it by directory, so the CLI sends no `?cwd=`; one sent by an
 * older CLI is ignored.
 */
export const GET = route({
  handler: async ({ actor }) => ok(await subjectBrief(actor.userId)),
})

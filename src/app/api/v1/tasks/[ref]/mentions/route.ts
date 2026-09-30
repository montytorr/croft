import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { findTask, TASK_LIST_FIELDS } from '@/lib/api/tasks'
import { mentionsOf } from '@/lib/api/mentions'
import { viewerOf } from '@/lib/api/visibility'

export const dynamic = 'force-dynamic'

/**
 * Every place another task named this one (CROFT-267): notes, comments,
 * descriptions and resolutions, decisions and findings first. The digest
 * carries the first few; this is the rest.
 */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200)
    return ok(await mentionsOf(task.id as string, limit, viewerOf(actor)))
  },
})

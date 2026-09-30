import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { findTask } from '@/lib/api/tasks'
import { recallFor } from '@/lib/api/recall'

export const dynamic = 'force-dynamic'

const bounded = (raw: string | null, fallback: number) =>
  Math.min(Math.max(Number(raw ?? fallback) || fallback, 1), 30)

/**
 * The decisions and knowledge that bear on this task, each with why it was
 * picked (CROFT-268). What `croft recall <ref>` prints.
 */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const embedded = task.project as { id: string; key: string } | { id: string; key: string }[]
    const project = Array.isArray(embedded) ? embedded[0] : embedded
    if (!project) return fail('internal_error', `Task ${params.ref} has no project.`)

    return ok(
      await recallFor(
        actor.userId,
        {
          id: task.id as string,
          ref: `${project.key}-${task.number}`,
          title: task.title as string,
          description: (task.description as string | null) ?? null,
          project_key: project.key,
          project_id: project.id,
        },
        {
          decisions: bounded(url.searchParams.get('decisions'), 8),
          knowledge: bounded(url.searchParams.get('knowledge'), 8),
        },
      ),
    )
  },
})

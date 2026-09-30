import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/db/client'
import { normaliseRemote } from '@/lib/api/repos'
import { resolveProject } from '@/lib/api/project-keys'

export const dynamic = 'force-dynamic'

/** Through a retired key too, so `croft map AC` claims the repo for HOL. */
const resolve = async (idOrKey: string) => (await resolveProject(idOrKey))?.project ?? null

const linkRepo = z.object({
  remote: z.string().min(1).max(500),
  // Read once, here, and never on the resolution path: `rev-list
  // --max-parents=0` walks the whole history, which the hook cannot afford.
  rootCommit: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
})

export const GET = route<{ id: string }>({
  handler: async ({ actor, params }) => {
    const project = await resolve(params.id)
    if (!project) return fail('not_found', `No project ${params.id}.`)

    const { data, error } = await admin()
      .from('project_repos')
      .select('remote, root_commit, created_at')
      .eq('project_id', project.id)
      .order('created_at')

    if (error) return fail('internal_error', error.message)
    return ok(data)
  },
})

/**
 * Claim a repository for this project, so every clone of it resolves without
 * anything stored on the machine doing the asking.
 *
 * Idempotent: re-running `croft map` in a fresh clone must not fail, and it is
 * the natural way to refresh a root commit recorded from a shallow checkout.
 */
export const POST = route<{ id: string }, z.infer<typeof linkRepo>>({
  schema: linkRepo,
  handler: async ({ actor, params, body }) => {
    const project = await resolve(params.id)
    if (!project) return fail('not_found', `No project ${params.id}.`)

    const { data, error } = await admin()
      .from('project_repos')
      .upsert(
        {
          project_id: project.id,
          owner_user_id: actor.userId,
          remote: normaliseRemote(body.remote),
          root_commit: body.rootCommit?.toLowerCase() ?? null,
        },
        { onConflict: 'project_id,remote' },
      )
      .select('remote, root_commit, created_at')
      .single()

    if (error) return failFromDb(error)
    return ok(data)
  },
})

export const DELETE = route<{ id: string }>({
  handler: async ({ params, url }) => {
    const project = await resolve(params.id)
    if (!project) return fail('not_found', `No project ${params.id}.`)

    const remote = url.searchParams.get('remote')
    if (!remote) return fail('validation_failed', 'A ?remote= is required.')

    const { error } = await admin()
      .from('project_repos')
      .delete()
      .eq('project_id', project.id)
      .eq('remote', normaliseRemote(remote))

    if (error) return fail('internal_error', error.message)
    return ok({ unlinked: normaliseRemote(remote) })
  },
})

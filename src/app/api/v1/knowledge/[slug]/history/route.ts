import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { knowledgeRevisions } from '@/lib/api/knowledge'

export const dynamic = 'force-dynamic'

type Params = { slug: string }

/**
 * What an entry used to say, and who changed it (CROFT-266).
 *
 * `version` is the live row's number, so the answer reads the same way the
 * revisions do: version N was replaced by the edit recorded on revision N.
 */
export const GET = route<Params>({
  handler: async ({ actor, params }) => {
    const found = await knowledgeRevisions(actor.userId, params.slug)
    if (!found) return fail('not_found', `No knowledge "${params.slug}".`)

    const { entry, revisions } = found
    return ok({
      slug: entry.slug,
      title: entry.title,
      version: (revisions[0]?.revision ?? 0) + 1,
      createdAt: entry.created_at,
      author: entry.actor_id,
      revisions,
    })
  },
})

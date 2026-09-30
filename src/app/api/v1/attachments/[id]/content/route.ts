import { route } from '@/lib/api/handler'
import { fail } from '@/lib/api/response'
import { signUrls } from '@/lib/attachments'
import { findAnyAttachment } from '@/lib/api/subject-attachments'

export const dynamic = 'force-dynamic'

/**
 * The stable address of a file — a task's or a subject's — for markdown to
 * embed: `![shot](/api/v1/attachments/<id>/content)`. Signed links expire in
 * the hour, so a write-up cannot hold one; this authenticates the viewer (a
 * session cookie or a key) and redirects to a freshly signed preview, which
 * /api/files serves with the sandbox headers every file gets.
 *
 * The Location is relative: behind a TLS-terminating proxy the request URL
 * reads http://, and an absolute redirect built from it would downgrade.
 */
export const GET = route<{ id: string }>({
  handler: async ({ params }) => {
    const row = await findAnyAttachment(params.id)
    if (!row) return fail('not_found', 'No such attachment.')
    const { previewUrl } = await signUrls(row.storage_path, row.filename, row.mime_type)
    return new Response(null, {
      status: 302,
      headers: { location: previewUrl, 'cache-control': 'private, no-store' },
    })
  },
})

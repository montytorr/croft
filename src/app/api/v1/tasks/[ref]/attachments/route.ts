import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { admin } from '@/lib/db/client'
import { findTask, refuseArchived } from '@/lib/api/tasks'
import { recordActivity } from '@/lib/api/activity'
import {
  buildStoragePath,
  effectiveMimeType,
  sanitizeFilename,
  sha256,
  signUrls,
  toAttachment,
  validateUpload,
  writeAttachment,
  removeAttachments,
} from '@/lib/attachments'

type StoredRow = {
  id: string
  original_name: string
  mime_type: string
  size_bytes: number
  sha256: string | null
  actor_id: string
  storage_path: string
  created_at: string
}

/**
 * The columns the task route has always answered, plus the lab's
 * `Attachment` fields (`filename`, `kind`, signed `preview_url` and
 * `download_url`, the stable `content_url`, `uploaded_by`). Additive: an
 * older CLI reading `original_name` still finds it.
 */
const present = async ({ storage_path, ...row }: StoredRow) => ({
  ...row,
  ...(await toAttachment({
    id: row.id,
    filename: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    storage_path,
    uploaded_by: row.actor_id,
    created_at: row.created_at,
  })),
})

export const dynamic = 'force-dynamic'

export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const { data, error } = await admin()
      .from('task_attachments')
      .select('id, original_name, mime_type, size_bytes, sha256, actor_id, storage_path, created_at')
      .eq('task_id', task.id)
      .order('created_at')

    if (error) return fail('internal_error', error.message)
    return ok(await Promise.all(((data ?? []) as StoredRow[]).map(present)))
  },
})

/**
 * multipart/form-data upload. No Zod here — FormData is not JSON, so the
 * fields are validated by hand, which is why the route wrapper only applies a
 * schema when one is given.
 */
export const POST = route<{ ref: string }>({
  handler: async ({ actor, params, req }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) {
      return fail('validation_failed', 'Send multipart/form-data with a "file" field.')
    }

    // HTML included: served only under a sandbox CSP (see /api/files).
    const type = effectiveMimeType(file.name, file.type)
    const rejection = validateUpload({ name: file.name, type, size: file.size })
    if (rejection) {
      return fail('validation_failed', rejection.reason, rejection.valid ? { validTypes: rejection.valid } : undefined)
    }

    const projectId = (task.project as { id: string } | undefined)?.id
    if (!projectId) return fail('internal_error', 'Task is missing its project.')

    const bytes = Buffer.from(await file.arrayBuffer())
    const storagePath = buildStoragePath(projectId, task.id, file.name)

    try {
      await writeAttachment(storagePath, bytes)
    } catch (error) {
      return fail('internal_error', `Upload failed: ${error instanceof Error ? error.message : error}`)
    }

    const { data, error } = await admin()
      .from('task_attachments')
      .insert({
        task_id: task.id,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        filename: sanitizeFilename(file.name),
        original_name: file.name,
        mime_type: type,
        size_bytes: file.size,
        storage_path: storagePath,
        sha256: sha256(bytes),
      })
      .select('id, original_name, mime_type, size_bytes, sha256, actor_id, storage_path, created_at')
      .single()

    if (error) {
      // Do not leave an orphan object behind if the row insert fails.
      await removeAttachments([storagePath])
      return fail('internal_error', error.message)
    }

    // A file arriving on a task is work, and it left no trace in the timeline.
    await recordActivity([
      {
        task_id: task.id,
        project_id: (task.project_id as string) ?? null,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event: 'attachment_added',
        data: { name: file.name, bytes: file.size, mime: type || null },
      },
    ], actor.userId, actor.host)

    // previewUrl/downloadUrl as before, beside the Attachment's snake_case pair.
    return ok(
      { ...(await present(data as StoredRow)), ...(await signUrls(storagePath, file.name, type)) },
      { status: 201 },
    )
  },
})

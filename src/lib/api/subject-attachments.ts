import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import type { Attachment } from '@/lib/lab/types'
import {
  buildSubjectStoragePath,
  effectiveMimeType,
  removeAttachments,
  sha256,
  toAttachment,
  validateUpload,
  writeAttachment,
} from '@/lib/attachments'
import type { Actor } from './auth'
import { isUuid } from './lab-admin'
import { fail } from './response'

/**
 * Files on a subject (075), stored and served exactly as a task's are: the
 * same allowlist and size limit, the same store, the same signed /api/files
 * links. Only the row lives in its own table.
 */

type Row = {
  id: string
  subject_id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  storage_path: string
  uploaded_by: string
  created_at: string
}

const COLUMNS = 'id, subject_id, filename, mime_type, size_bytes, storage_path, uploaded_by, created_at'
const rows = (result: { rows: unknown[] }) => normalizeDatabaseValue(result.rows) as Row[]

/** Oldest first, as a task's files are. */
export const listSubjectAttachments = async (subjectId: string): Promise<Attachment[]> => {
  const found = rows(
    await pool().query(`select ${COLUMNS} from subject_attachments where subject_id = $1 order by created_at, id`, [subjectId]),
  )
  return Promise.all(found.map(toAttachment))
}

export const findSubjectAttachment = async (id: string): Promise<Row | null> => {
  if (!isUuid(id)) return null
  return rows(await pool().query(`select ${COLUMNS} from subject_attachments where id = $1`, [id]))[0] ?? null
}

type Outcome<T> = { ok: true; value: T } | { ok: false; response: Response }

/** Validates, stores the bytes, then records the row; an orphan object is removed if the row fails. */
export const addSubjectAttachment = async (
  actor: Actor,
  subjectId: string,
  file: File,
): Promise<Outcome<Attachment>> => {
  const type = effectiveMimeType(file.name, file.type)
  const rejection = validateUpload({ name: file.name, type, size: file.size })
  if (rejection) {
    return {
      ok: false,
      response: fail('validation_failed', rejection.reason, rejection.valid ? { validTypes: rejection.valid } : undefined),
    }
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const storagePath = buildSubjectStoragePath(subjectId, file.name)
  try {
    await writeAttachment(storagePath, bytes)
  } catch (error) {
    return { ok: false, response: fail('internal_error', `Upload failed: ${error instanceof Error ? error.message : error}`) }
  }

  const filename = (file.name.split(/[/\\]/).pop() || 'file').slice(0, 255)
  try {
    const row = rows(
      await pool().query(
        `insert into subject_attachments
           (subject_id, filename, mime_type, size_bytes, storage_path, sha256, uploaded_by, user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${COLUMNS}`,
        [subjectId, filename, type, file.size, storagePath, sha256(bytes), actor.actorId, actor.userId],
      ),
    )[0]!
    return { ok: true, value: await toAttachment(row) }
  } catch (error) {
    await removeAttachments([storagePath])
    return { ok: false, response: fail('internal_error', error instanceof Error ? error.message : String(error)) }
  }
}

/** Object first, as for a task's file: a leftover row is recoverable, a leaked object is not findable. */
export const deleteSubjectAttachment = async (subjectId: string, id: string): Promise<Outcome<{ deleted: true; id: string }>> => {
  const row = await findSubjectAttachment(id)
  if (!row || row.subject_id !== subjectId) return { ok: false, response: fail('not_found', 'No such file on this subject.') }
  try {
    await removeAttachments([row.storage_path])
  } catch (error) {
    return { ok: false, response: fail('internal_error', `Storage delete failed: ${error instanceof Error ? error.message : error}`) }
  }
  await pool().query('delete from subject_attachments where id = $1', [row.id])
  return { ok: true, value: { deleted: true, id: row.id } }
}

/**
 * Any stored file by id, a task's or a subject's, in the one shape
 * `toAttachment` takes. What `content_url` resolves through.
 *
 * Only a file whose subject — or whose task's subject — `viewerId` may see:
 * an id is a capability-shaped string that travels in markdown, so a file on
 * a private subject must answer exactly as an id that names nothing.
 */
export const findAnyAttachment = async (
  id: string,
  viewerId: string,
): Promise<(Omit<Row, 'subject_id'> & { task_id: string | null; subject_id: string | null }) | null> => {
  if (!isUuid(id)) return null
  const found = normalizeDatabaseValue(
    (
      await pool().query(
        `select id, null::uuid as task_id, subject_id, filename, mime_type, size_bytes, storage_path, uploaded_by, created_at
           from subject_attachments a
          where a.id = $1 and croft_subject_visible(a.subject_id, $2::uuid)
         union all
         select a.id, a.task_id, null::uuid, a.original_name, a.mime_type, a.size_bytes, a.storage_path, a.actor_id, a.created_at
           from task_attachments a
           join tasks t on t.id = a.task_id
          where a.id = $1 and croft_task_visible(t.subject_id, $2::uuid)
         limit 1`,
        [id, viewerId],
      )
    ).rows,
  ) as (Omit<Row, 'subject_id'> & { task_id: string | null; subject_id: string | null })[]
  return found[0] ?? null
}

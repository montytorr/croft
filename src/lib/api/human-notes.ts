import { normalizeDatabaseValue, pool } from '@/lib/db/client'
import { bodyProblems } from '@/lib/markdown-body'
import type { SubjectHumanNote } from '@/lib/lab/types'
import type { Actor } from './auth'
import { isLabAdmin, isUuid } from './lab-admin'
import { fail } from './response'

/**
 * People's notes on a subject (075): free markdown, editable and removable by
 * the person who wrote them. Separate from the work log, which is
 * append-only and mostly agents, and from the write-up, which is one shared
 * document.
 *
 * An agent may write one; it is the agent's human's note, so the author is
 * always `actor.userId` and the same human can edit it from the board.
 */

type Row = {
  id: string
  body: string
  user_id: string | null
  author_name: string | null
  actor_id: string
  created_at: string
  updated_at: string
}

const SELECT = `
  select n.id, n.body, n.user_id, n.actor_id, n.created_at, n.updated_at,
         coalesce(nullif(trim(p.display_name), ''), u.email) as author_name
    from subject_human_notes n
    left join app_users u on u.id = n.user_id
    left join user_profiles p on p.id = u.id`

const toNote = (row: Row): SubjectHumanNote => ({
  id: row.id,
  body: row.body,
  // A note outlives its author's account (set null); the frozen actor label
  // is then the only name left for it.
  author: { id: row.user_id ?? '', name: row.author_name ?? row.actor_id },
  created_at: row.created_at,
  updated_at: row.updated_at,
})

const rows = (result: { rows: unknown[] }) => normalizeDatabaseValue(result.rows) as Row[]

/** Newest first. */
export const listSubjectHumanNotes = async (subjectId: string): Promise<SubjectHumanNote[]> =>
  rows(await pool().query(`${SELECT} where n.subject_id = $1 order by n.created_at desc, n.id desc`, [subjectId])).map(toNote)

const findNote = async (subjectId: string, id: string): Promise<Row | null> => {
  if (!isUuid(id)) return null
  return rows(await pool().query(`${SELECT} where n.id = $1 and n.subject_id = $2`, [id, subjectId]))[0] ?? null
}

/**
 * The readable-markdown rule task bodies meet (CROFT-312), for agents only:
 * a person typing into the composer sees what they are writing.
 */
export const refuseUnreadableNote = (actor: Pick<Actor, 'actorType'>, body: string): Response | null => {
  if (actor.actorType !== 'agent') return null
  const problems = bodyProblems(body)
  if (problems.length === 0) return null
  return fail(
    'validation_failed',
    'This note is hard to read as written, so it was not saved. Notes are markdown: fix each point below ' +
      'and send it again with real line breaks.\n' +
      problems.map((p) => `  - ${p}`).join('\n'),
    { field: 'body', problems },
  )
}

export const addSubjectHumanNote = async (
  actor: Actor,
  subjectId: string,
  body: string,
): Promise<SubjectHumanNote> => {
  const inserted = rows(
    await pool().query(
      `insert into subject_human_notes (subject_id, body, user_id, actor_type, actor_id)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [subjectId, body, actor.userId, actor.actorType, actor.actorId],
    ),
  )[0]!
  return toNote((await findNote(subjectId, inserted.id))!)
}

const notFound = (id: string) => fail('not_found', `No note ${id} on this subject.`)

/** The author edits; nobody else does, admins included — it is their words. */
export const updateSubjectHumanNote = async (
  actor: Actor,
  subjectId: string,
  id: string,
  body: string,
): Promise<{ ok: true; note: SubjectHumanNote } | { ok: false; response: Response }> => {
  const note = await findNote(subjectId, id)
  if (!note) return { ok: false, response: notFound(id) }
  if (note.user_id !== actor.userId) {
    return { ok: false, response: fail('forbidden', 'Only the person who wrote a note can edit it.') }
  }
  await pool().query('update subject_human_notes set body = $2 where id = $1', [id, body])
  return { ok: true, note: toNote((await findNote(subjectId, id))!) }
}

/** The author, or an administrator tidying up. */
export const deleteSubjectHumanNote = async (
  actor: Actor,
  subjectId: string,
  id: string,
): Promise<{ ok: true } | { ok: false; response: Response }> => {
  const note = await findNote(subjectId, id)
  if (!note) return { ok: false, response: notFound(id) }
  if (note.user_id !== actor.userId && !isLabAdmin(actor)) {
    return { ok: false, response: fail('forbidden', 'Only the person who wrote a note, or an administrator, can delete it.') }
  }
  await pool().query('delete from subject_human_notes where id = $1', [id])
  return { ok: true }
}

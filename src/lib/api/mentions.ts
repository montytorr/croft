import { pool } from '@/lib/db/client'
import { taskVisibleSql, type Viewer } from './visibility'

/**
 * Where else a task was named (CROFT-267).
 *
 * `task_mentions` is filled by triggers from every note, comment, description
 * and resolution that writes a resolvable ref; this reads it backwards. The
 * order is the point: a decision or a finding about this task outranks a
 * passing mention, and a resolution is a decision by definition.
 */

export type Mention = {
  ref: string
  title: string
  status: string
  source: 'note' | 'comment' | 'description' | 'resolution'
  /** The note's kind, when the mention is in a note. */
  kind: string | null
  by: string | null
  at: string
  /** The ref as the author wrote it — a retired key reads differently. */
  writtenAs: string
  /** The text around the mention. */
  excerpt: string
}

const WINDOW = 160

/** A window of `text` around the first occurrence of `ref`, on word boundaries. */
export const excerptAround = (text: string, ref: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const at = flat.search(new RegExp(`\\b${ref.replace(/[-]/g, '\\-')}\\b`))
  if (at < 0) return flat.length > WINDOW * 2 ? `${flat.slice(0, WINDOW * 2)}…` : flat

  let start = Math.max(0, at - WINDOW)
  let end = Math.min(flat.length, at + ref.length + WINDOW)
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space >= 0 && space < at) start = space + 1
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end)
    if (space > at + ref.length) end = space
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/**
 * Mentions of `taskId`, from tasks `viewer` may see only: a private todo
 * that names a lab task must not surface on the lab task — its title, its
 * excerpt or its place in the count.
 */
export const mentionsOf = async (
  taskId: string,
  limit: number,
  viewer: Pick<Viewer, 'id'>,
): Promise<{ total: number; mentions: Mention[] }> => {
  const { rows } = await pool().query(
    `select p.key || '-' || s.number as ref, s.title, s.status, m.source,
            n.kind, m.ref_as_written, m.created_at,
            coalesce(n.actor_id, c.actor_id,
                     case when m.source = 'resolution' then s.resolved_by end,
                     s.actor_id) as by,
            coalesce(n.note, c.content,
                     case m.source when 'description' then s.description else s.resolution end) as text,
            count(*) over () as total
       from task_mentions m
       join tasks s on s.id = m.source_task_id
       join projects p on p.id = s.project_id
       left join task_notes n on n.id = m.note_id
       left join task_comments c on c.id = m.comment_id
      where m.target_task_id = $1
        and ${taskVisibleSql('s.subject_id', '$3')}
      order by case
                 when m.source = 'resolution' or n.kind in ('decision', 'finding') then 0
                 when n.kind = 'handoff' or m.source = 'description' then 1
                 else 2
               end,
               m.created_at desc
      limit $2`,
    [taskId, limit, viewer.id],
  )

  return {
    total: Number(rows[0]?.total ?? 0),
    mentions: rows.map((r) => ({
      ref: r.ref as string,
      title: r.title as string,
      status: r.status as string,
      source: r.source as Mention['source'],
      kind: (r.kind as string | null) ?? null,
      by: (r.by as string | null) ?? null,
      at: new Date(r.created_at as string).toISOString(),
      writtenAs: r.ref_as_written as string,
      excerpt: excerptAround(String(r.text ?? ''), r.ref_as_written as string),
    })),
  }
}

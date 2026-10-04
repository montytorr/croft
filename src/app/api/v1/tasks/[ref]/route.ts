import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/db/client'
import { diffTaskEvents, recordActivity } from '@/lib/api/activity'
import { findTask, RELEASED_CLAIM, refOfRow, refuseArchived, resolveParent, subjectOfTask } from '@/lib/api/tasks'
import { buildDigest } from '@/lib/api/digest'
import { refuseHandedOff } from '@/lib/api/handoff-shape'
import { viewerOf, withoutHiddenLinks } from '@/lib/api/visibility'
import { peopleByIds, resolveAssignee, withAssignee } from '@/lib/api/people'
import { removeAttachments } from '@/lib/attachments'
import { refuseUnreadableBody } from '@/lib/api/task-body'
import { isTerminal, updateTaskSchema, RESOLUTION_KINDS } from '@/schemas/task'

export const dynamic = 'force-dynamic'

/** One task. `?view=digest` is the cheap read: the answer, the durable notes, a clipped body. */
export const GET = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const found = await findTask(actor, params.ref)
    if (!found) return fail('not_found', `No task ${params.ref}.`)
    const task = await withoutHiddenLinks(await withAssignee(found), actor.userId)

    // A todo says which subject it is part of, by ref, so nobody has to map a uuid.
    const subject = await subjectOfTask(task.subject_id, actor.userId)

    // `full` stays the default so nothing already calling this changes
    // behaviour. The CLI asks for the digest explicitly.
    if (url.searchParams.get('view') === 'digest') {
      // Only on the tasks that have them: the digest is the cheapest view.
      const lab = {
        ...(subject ? { subject } : {}),
        ...(task.handoff ? { handoff: task.handoff } : {}),
      }
      return ok({ ...(await buildDigest(task, viewerOf(actor))), ...lab })
    }
    return ok({ ...task, subject })
  },
})

/**
 * Offers the agent something to close with when it forgets a resolution.
 * Prefers the last checkpoint (the freshest statement of where things stood),
 * then the most recent `finding` note.
 */
const suggestResolution = async (taskId: string, checkpoint: unknown) => {
  if (typeof checkpoint === 'string' && checkpoint.trim()) return checkpoint

  const { data } = await admin()
    .from('task_notes')
    .select('note')
    .eq('task_id', taskId)
    .in('kind', ['finding', 'decision'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data?.note ?? null
}

export const PATCH = route<{ ref: string }, z.infer<typeof updateTaskSchema>>({
  schema: updateTaskSchema,
  secretFields: ['title', 'description', 'resolution'],
  handler: async ({ actor, params, body }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    // A handed-off todo's status belongs to the other tracker. Title and body edits stay open.
    if (body.status !== undefined && body.status !== task.status) {
      const handedOff = refuseHandedOff(task, refOfRow(task) ?? params.ref)
      if (handedOff) return handedOff
    }

    const unreadable = refuseUnreadableBody(actor, body.description, `croft update ${params.ref} --body -`)
    if (unreadable) return unreadable

    const nextStatus = body.status ?? (task.status as string)
    const existingResolution = task.resolution as string | null

    // The rule that makes closed tasks worth finding later: you cannot close
    // a task without saying how it ended. Enforced here rather than as a DB
    // constraint, so imports and admin fixes remain possible.
    if (isTerminal(nextStatus as never) && !body.resolution && !existingResolution) {
      const suggestion = await suggestResolution(task.id, task.checkpoint_summary)
      return fail(
        'resolution_required',
        `Closing a task requires a resolution — what was actually done, and why. ` +
          `Pass "resolution" (and optionally "resolutionKind": ${RESOLUTION_KINDS.join(' | ')}).`,
        suggestion ? { suggestedResolution: suggestion } : undefined,
      )
    }

    /**
     * And the other half of the same rule: a resolution is the statement
     * "this is settled, and here is how", so writing one without closing is a
     * contradiction the store cannot represent honestly.
     *
     * It was accepted silently. An agent wrote the answer, believed it had
     * finished, and the task sat in backlog carrying an answered dot — which
     * also offers it to `check` as settled prior work, the failure CROFT-120
     * found on OD-36. Refused rather than auto-closed, because `done` and
     * `cancelled` are different claims about the work and only the caller
     * knows which one it is making.
     */
    if (body.resolution !== undefined && body.resolution !== null && !isTerminal(nextStatus as never)) {
      return fail(
        'validation_failed',
        `A resolution says a task is settled, so it cannot be written while ${params.ref} is ` +
          `"${nextStatus}". Send a terminal status with it — "done" if it was, "cancelled" if ` +
          `it will not be — or record it as a note instead if the work is still open.`,
        { status: nextStatus, terminal: ['done', 'cancelled'] },
      )
    }

    const patch: Record<string, unknown> = {}
    if (body.title !== undefined) patch.title = body.title
    if (body.description !== undefined) patch.description = body.description
    if (body.type !== undefined) patch.type = body.type
    if (body.status !== undefined) patch.status = body.status
    if (body.priority !== undefined) patch.priority = body.priority
    if (body.labels !== undefined) patch.labels = body.labels
    if (body.dueDate !== undefined) patch.due_date = body.dueDate
    if (body.resolutionKind !== undefined) patch.resolution_kind = body.resolutionKind

    if (body.assignee !== undefined) {
      const owner = await resolveAssignee(body.assignee, actor.userId)
      if (!owner.ok) return fail(owner.code, owner.error)
      patch.assignee_user_id = owner.person.id
    }

    if (body.resolution !== undefined) {
      patch.resolution = body.resolution
      patch.resolved_at = new Date().toISOString()
      patch.resolved_by = actor.actorId
      if (!body.resolutionKind && !task.resolution_kind) patch.resolution_kind = 'fixed'
    }

    if (body.parentRef !== undefined) {
      if (body.parentRef === null) {
        patch.parent_id = null
      } else {
        const parent = await resolveParent(actor, task.id, body.parentRef)
        if ('error' in parent) return fail('validation_failed', parent.error)
        patch.parent_id = parent.id
      }
    }

    if (body.duplicateOf !== undefined) {
      if (body.duplicateOf === null) {
        patch.duplicate_of = null
      } else {
        const original = await findTask(actor, body.duplicateOf, 'id, number, title')
        if (!original) return fail('not_found', `No task ${body.duplicateOf}.`)
        if (original.id === task.id) {
          return fail('validation_failed', 'A task cannot duplicate itself.')
        }
        patch.duplicate_of = original.id
        // Naming the original is the whole point, so treat it as the caller
        // saying "duplicate" even if they only sent the pointer. The database
        // refuses the pointer without the kind, and failing on a technicality
        // here would be unhelpful.
        if (!body.resolutionKind && task.resolution_kind !== 'duplicate') {
          patch.resolution_kind = 'duplicate'
        }
      }
    }

    // Finishing a task releases it (see RELEASED_CLAIM; `closeTask` does the same).
    if (body.status && isTerminal(body.status) && task.claimed_by) {
      Object.assign(patch, RELEASED_CLAIM)
    }

    /**
     * Reopening drops the answer with it.
     *
     * A resolution is the claim "this is settled, and here is how" — so a task
     * that is open again while still carrying one is lying twice: the list
     * shows its answered dot, and `check` offers it as prior work that was
     * resolved. OD-36 sat in backlog for two days carrying a resolution about
     * an entirely different task, because an agent corrected a mis-filed close
     * by reverting the status and the API kept the text.
     *
     * The old text is not destroyed — it goes into the activity event, where
     * the history can still show what was withdrawn.
     */
    const reopening =
      body.status &&
      !isTerminal(body.status) &&
      isTerminal(task.status as never) &&
      body.resolution === undefined

    if (reopening) {
      patch.resolution = null
      patch.resolution_kind = null
      patch.resolved_at = null
      patch.resolved_by = null
    }

    if (Object.keys(patch).length === 0) {
      return fail('validation_failed', 'No fields to update.')
    }

    const { data, error } = await admin()
      .from('tasks')
      .update(patch)
      .eq('id', task.id)
      .select('id, number, title, type, status, priority, labels, assignee_user_id, resolution, resolution_kind, updated_at')
      .single()

    if (error) {
      return failFromDb(error, {
        // The database refuses a duplicate pointer without the matching kind,
        // which is otherwise a bare constraint name in the response.
        '23514': error.message.includes('tasks_duplicate_needs_kind')
          ? 'A duplicate pointer only makes sense with resolutionKind "duplicate". Send both, or send duplicateOf: null.'
          : error.message,
      })
    }

    const events = diffTaskEvents(actor, task.id, task, patch)
    const reassigned = events.find((e) => e.event === 'assignee_changed')
    if (reassigned) {
      // Ids for filtering, names for reading: the feed shows who, not a uuid.
      const people = await peopleByIds([String(reassigned.data.from ?? ''), String(reassigned.data.to ?? '')])
      reassigned.data.from_name = people.get(String(reassigned.data.from))?.name ?? null
      reassigned.data.to_name = people.get(String(reassigned.data.to))?.name ?? null
    }
    await recordActivity(events, actor.userId, actor.host)

    // The withdrawn answer, kept where history can still show it.
    if (reopening && task.resolution) {
      await recordActivity([
        {
          task_id: task.id,
          actor_type: actor.actorType,
          actor_id: actor.actorId ?? 'unknown',
          event: 'resolution_withdrawn',
          data: {
            kind: task.resolution_kind ?? null,
            resolution: String(task.resolution).slice(0, 2000),
          },
        },
      ], actor.userId, actor.host)
    }

    return ok(await withAssignee(data))
  },
})

/**
 * Deletes a task, and is deliberately hard to reach.
 *
 * This used to take a ref and delete it — no confirmation, and no objection to
 * a task carrying children, a work log or dependants. In a store whose whole
 * value is that things do not quietly vanish, the unguarded version was worse
 * than having none: `cancel` is what almost every caller reaching for this
 * actually wants, because it keeps the record and the reason.
 *
 * So this is for junk that should never have existed — a scratch task, a batch
 * filed by a broken import — and it refuses anything that has accumulated
 * meaning. What it refuses can still be deleted, by detaching or deleting the
 * things that depend on it first, which is the point: that is a decision per
 * item rather than one cascade nobody reviewed.
 */
const countForOthers = async (table: string, taskId: string, actorId: string) => {
  const { count, error } = await admin()
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('task_id', taskId)
    .neq('actor_id', actorId)
  if (error) throw new Error(`${table} count failed: ${error.message}`)
  return count ?? 0
}

const countFor = async (table: string, column: string, id: string) => {
  const { count, error } = await admin()
    .from(table)
    .select(column, { count: 'exact', head: true })
    .eq(column, id)
  if (error) throw new Error(`${table}.${column} count failed: ${error.message}`)
  return count ?? 0
}

export const DELETE = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const task = await findTask(actor, params.ref)
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    const archived = refuseArchived(task)
    if (archived) return archived

    const ref = `${(task.project as { key: string } | undefined)?.key ?? ''}-${task.number as number}`

    // Notes and comments the CALLER did not write. Its own are not a history
    // worth protecting from it: a scratch task that had acquired a single note
    // of its author's own became permanently undeletable, because delete
    // refused a work log and nothing could remove one. That left junk no
    // mechanism could clear, which is worse than the friction was worth.
    const [children, notes, comments] = await Promise.all([
      countFor('tasks', 'parent_id', task.id),
      countForOthers('task_notes', task.id, actor.actorId),
      countForOthers('task_comments', task.id, actor.actorId),
    ])

    const holding = [
      children && `${children} child task${children === 1 ? '' : 's'}`,
      notes && `${notes} work-log note${notes === 1 ? '' : 's'} from somebody else`,
      comments && `${comments} comment${comments === 1 ? '' : 's'} from somebody else`,
    ].filter(Boolean) as string[]

    if (holding.length > 0) {
      return fail(
        'validation_failed',
        `${ref} has ${holding.join(', ')}. Delete is for tasks that should never have ` +
          `existed; this one has a history. Cancel it instead — \`status: cancelled\` with a ` +
          `resolution keeps the record and the reason — or detach what it holds first.`,
        { holding, children, notes, comments },
      )
    }

    if (url.searchParams.get('confirm') !== ref) {
      return fail(
        'validation_failed',
        `This permanently deletes ${ref} and cannot be undone. Repeat the ref to ` +
          `confirm: ?confirm=${ref}`,
        { requiresConfirmation: ref },
      )
    }

    // Storage objects are outside the database cascade, so they have to go
    // explicitly or the bucket keeps orphans nobody can find a task for.
    const { data: files } = await admin()
      .from('task_attachments')
      .select('storage_path')
      .eq('task_id', task.id)
    const paths = ((files ?? []) as { storage_path: string }[]).map((f) => f.storage_path)
    if (paths.length > 0) await removeAttachments(paths)

    /**
     * The tombstone, written BEFORE the delete.
     *
     * task_id detaches rather than cascading now, so this row survives — but
     * only if it exists first. Written after the delete it would have no task
     * to hang from and the ref would already be unrecoverable. The ref and
     * title go into `data` for the same reason: once the row is gone they are
     * the only record of what was removed.
     */
    await recordActivity([
      {
        task_id: task.id,
        project_id: (task.project_id as string) ?? null,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        event: 'task_deleted',
        data: { ref, title: String(task.title ?? '').slice(0, 200) },
      },
    ], actor.userId, actor.host)

    /**
     * Every event this task leaves behind gets its ref, while the ref is still
     * knowable.
     *
     * task_id detaches on delete, so the rows survive — but the feed resolves a
     * name through the task, and a detached row had nothing to show but the
     * project key. Stamping it now is the last moment anything can.
     */
    await admin().rpc('croft_stamp_ref', { p_task: task.id, p_ref: ref })

    const { error } = await admin().from('tasks').delete().eq('id', task.id)
    if (error) return failFromDb(error)
    return ok({ deleted: true, ref, id: task.id, attachmentsRemoved: paths.length })
  },
})

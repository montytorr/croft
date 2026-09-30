import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin, pool } from '@/lib/db/client'
import type { Actor } from '@/lib/api/auth'
import { recordActivity } from '@/lib/api/activity'
import { findTask, refOfRow, refuseArchived, TASK_LIST_FIELDS, type TaskRow } from '@/lib/api/tasks'
import { restrictTo, visibleTasksOr } from '@/lib/api/visibility'

export const dynamic = 'force-dynamic'

const body = z.object({
  /** The other task, as a ref (`CAI-42`) or uuid. */
  ref: z.string().min(2).max(60),
  /**
   * 'blocked-by' — the other task must finish first (the default, because it
   * is how people phrase it: "this is blocked by that").
   * 'blocks'     — this task must finish before the other.
   */
  direction: z.enum(['blocked-by', 'blocks']).default('blocked-by'),
})

/** A task of a private or members subject: its ref is not everyone's to read. */
const restricted = async (subjectId: unknown): Promise<boolean> => {
  if (typeof subjectId !== 'string' || !subjectId) return false
  const { rows } = await pool().query<{ v: string }>('select visibility as v from subjects where id = $1', [subjectId])
  return (rows[0]?.v ?? 'lab') !== 'lab'
}

/** Whether `named` may be written into `host`'s history: everyone who can read `host` can see `named`. */
const nameableOn = async (named: TaskRow, host: TaskRow) =>
  !named.subject_id || named.subject_id === host.subject_id || !(await restricted(named.subject_id))

const FLIPPED = { 'blocked-by': 'blocks', blocks: 'blocked-by' } as const

/**
 * The events a link or unlink writes (v0.4). Normally one, on the path task,
 * naming the other. When the other is a private or members todo that the
 * path task's readers may not see, that ref stays out of the path task's
 * history (`other: null`) and the full event goes on the other task instead,
 * the other way round — so a lab task's activity never names a private one.
 */
const dependencyEvents = async (
  actor: Actor,
  event: 'dependency_added' | 'dependency_removed',
  task: TaskRow,
  other: TaskRow,
  refs: { task: string; other: string },
  direction: 'blocked-by' | 'blocks',
) => {
  const onTask = await nameableOn(other, task)
  const base = { actor_type: actor.actorType, actor_id: actor.actorId, event }
  const events = [
    {
      ...base,
      task_id: task.id,
      project_id: (task.project_id as string) ?? null,
      data: { other: onTask ? refs.other : null, direction },
    },
  ]
  if (!onTask) {
    events.push({
      ...base,
      task_id: other.id,
      project_id: (other.project_id as string) ?? null,
      data: { other: (await nameableOn(task, other)) ? refs.task : null, direction: FLIPPED[direction] },
    })
  }
  return events
}

export const GET = route<{ ref: string }>({
  handler: async ({ actor, params }) => {
    const task = await findTask(actor, params.ref, TASK_LIST_FIELDS)
    if (!task) return fail('not_found', `No task ${params.ref}.`)

    const [blockedBy, blocks] = await Promise.all([
      admin().from('task_deps').select('blocking_id').eq('blocked_id', task.id),
      admin().from('task_deps').select('blocked_id').eq('blocking_id', task.id),
    ])

    const ids = [
      ...((blockedBy.data ?? []) as { blocking_id: string }[]).map((r) => r.blocking_id),
      ...((blocks.data ?? []) as { blocked_id: string }[]).map((r) => r.blocked_id),
    ]
    if (ids.length === 0) return ok([])

    // A link to a task the caller cannot see is not shown: its title and ref
    // are the private subject's business.
    const { data } = await restrictTo(
      admin()
        .from('tasks')
        .select('id, number, title, status, project:projects!project_id!inner(key)')
        .in('id', ids),
      await visibleTasksOr(actor.userId),
    )

    type Row = { id: string; number: number; title: string; status: string; project: { key: string } | { key: string }[] }
    const blockedIds = new Set(
      ((blockedBy.data ?? []) as { blocking_id: string }[]).map((r) => r.blocking_id),
    )

    return ok(
      ((data ?? []) as unknown as Row[]).map((row) => {
        const proj = Array.isArray(row.project) ? row.project[0] : row.project
        return {
          ref: `${proj?.key}-${row.number}`,
          title: row.title,
          status: row.status,
          direction: blockedIds.has(row.id) ? 'blocked-by' : 'blocks',
        }
      }),
    )
  },
})

export const POST = route<{ ref: string }, z.infer<typeof body>>({
  schema: body,
  handler: async ({ actor, params, body: input }) => {
    const [task, other] = await Promise.all([
      findTask(actor, params.ref, TASK_LIST_FIELDS),
      findTask(actor, input.ref, TASK_LIST_FIELDS),
    ])
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    if (!other) return fail('not_found', `No task ${input.ref}.`)
    if (task.id === other.id) return fail('validation_failed', 'A task cannot block itself.')
    const archived = refuseArchived(task) ?? refuseArchived(other)
    if (archived) return archived

    const blocked = input.direction === 'blocked-by' ? task.id : other.id
    const blocking = input.direction === 'blocked-by' ? other.id : task.id

    // A cycle would make "what is ready to start?" unanswerable, which is the
    // only question dependencies exist to answer. Reject the direct case;
    // deeper cycles are checked below.
    const { data: reverse } = await admin()
      .from('task_deps')
      .select('blocked_id')
      .eq('blocked_id', blocking)
      .eq('blocking_id', blocked)
      .maybeSingle()
    if (reverse) {
      return fail('conflict', 'That would create a cycle — the reverse link already exists.')
    }

    const { error } = await admin()
      .from('task_deps')
      .insert({ blocked_id: blocked, blocking_id: blocking })
    if (error) {
      return failFromDb(error, { '23505': 'That dependency already exists.' })
    }

    // Which way round is the whole meaning here, so it is recorded, not implied.
    await recordActivity(
      await dependencyEvents(
        actor,
        'dependency_added',
        task,
        other,
        { task: refOfRow(task) ?? params.ref, other: refOfRow(other) ?? input.ref },
        input.direction,
      ),
      actor.userId,
      actor.host,
    )

    return ok({ blocked, blocking, direction: input.direction }, { status: 201 })
  },
})

/**
 * Takes its arguments in the query string, not a body: the shared route
 * wrapper does not parse DELETE bodies, and a DELETE body is unreliable
 * through proxies anyway.
 *
 *   DELETE /api/v1/tasks/CAI-42/dependencies?ref=CAI-40&direction=blocked-by
 */
export const DELETE = route<{ ref: string }>({
  handler: async ({ actor, params, url }) => {
    const parsed = body.safeParse({
      ref: url.searchParams.get('ref') ?? undefined,
      direction: url.searchParams.get('direction') ?? undefined,
    })
    if (!parsed.success) {
      return fail('validation_failed', 'Provide ?ref=<the other task>.', {
        issues: parsed.error.issues,
      })
    }
    const input = parsed.data

    const [task, other] = await Promise.all([
      findTask(actor, params.ref, TASK_LIST_FIELDS),
      findTask(actor, input.ref, TASK_LIST_FIELDS),
    ])
    if (!task) return fail('not_found', `No task ${params.ref}.`)
    if (!other) return fail('not_found', `No task ${input.ref}.`)
    const archived = refuseArchived(task) ?? refuseArchived(other)
    if (archived) return archived

    const blocked = input.direction === 'blocked-by' ? task.id : other.id
    const blocking = input.direction === 'blocked-by' ? other.id : task.id

    const { error, count } = await admin()
      .from('task_deps')
      .delete({ count: 'exact' })
      .eq('blocked_id', blocked)
      .eq('blocking_id', blocking)
    if (error) return failFromDb(error)
    // Reported rather than swallowed: a silent no-op here looked like success
    // while the link stayed on screen.
    if (!count) return fail('not_found', `${params.ref} is not linked to ${input.ref} that way.`)
    await recordActivity(
      await dependencyEvents(
        actor,
        'dependency_removed',
        task,
        other,
        { task: refOfRow(task) ?? params.ref, other: refOfRow(other) ?? input.ref },
        input.direction,
      ),
      actor.userId,
      actor.host,
    )

    return ok({ removed: true })
  },
})

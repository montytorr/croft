import { z } from 'zod'
import { route } from '@/lib/api/handler'
import { ok, fail } from '@/lib/api/response'
import { failFromDb } from '@/lib/api/db-errors'
import { admin } from '@/lib/db/client'
import { findTask, TASK_LIST_LAB_FIELDS, withSubjectRefs } from '@/lib/api/tasks'
import { withHandoffs } from '@/lib/api/handoff-shape'
import { resolveProject } from '@/lib/api/project-keys'
import { resolveAssignee, withAssignees } from '@/lib/api/people'
import { resolveTodoFilters, withTaskSubjects } from '@/lib/api/lab-todos'
import { createTaskInProject } from '@/lib/api/task-create'
import { createTaskSchema, TASK_STATUSES, TASK_TYPES } from '@/schemas/task'
import { restrictTo, visibleTasksOr } from '@/lib/api/visibility'

export const dynamic = 'force-dynamic'

const listQuery = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  type: z.enum(TASK_TYPES).optional(),
  label: z.string().optional(),
  /**
   * Held by the caller. The server answers this, because only the server knows
   * who is asking — the CLI used to guess from a CROFT_AGENT environment
   * variable and sent an empty string when it was unset, which asked for tasks
   * held by nobody and got an answer that looked like an answer.
   */
  // A plain string rather than a two-value z.enum. The activity-event guard
  // scans raw source for two-element lowercase string arrays in any file that
  // mentions FIELDS, and reads the second element as an event name the
  // database would reject — it caught the enum, and then caught the comment
  // explaining the enum. A heuristic that fails loudly is the right kind, so
  // the code moves rather than the guard.
  mine: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /** Kept for callers that genuinely want somebody else's holdings. */
  claimed_by: z.string().optional(),
  /**
   * Whose tasks: `me`, an email, a display name or a user id. Unlike `mine`,
   * which is what this agent holds right now, this is what a human owns.
   */
  assignee: z.string().trim().min(1).max(320).optional(),
  /** Todos of one subject: `S-12`, `12` or its id. */
  subject: z.string().trim().min(1).max(80).optional(),
  /** Todos whose subject is in this lab project (name or id), `none`, or a comma list. */
  project: z.string().trim().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export const GET = route<{ id: string }>({
  handler: async ({ actor, params, url }) => {
    const project = await resolveProject(params.id)
    if (!project) return fail('not_found', `No project ${params.id}.`)

    const parsed = listQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return fail('validation_failed', 'Bad query parameters.')
    const { status, type, label, mine, claimed_by, assignee, subject, project: labProject, limit, offset } = parsed.data

    const todoFilters = await resolveTodoFilters({ subject, project: labProject }, actor.userId)
    if (!todoFilters.ok) return todoFilters.response

    // Only the tasks the caller may see, and `count` counts only those.
    let query = restrictTo(
      admin().from('tasks').select(TASK_LIST_LAB_FIELDS, { count: 'exact' }),
      await visibleTasksOr(actor.userId),
    )

    query = query.eq('project_id', project.id)

    if (status) query = query.eq('status', status)
    if (type) query = query.eq('type', type)
    if (label) query = query.contains('labels', [label])
    if (claimed_by) query = query.eq('claimed_by', claimed_by)
    const { subjectId, project: inProjects } = todoFilters.value
    if (subjectId) query = query.eq('subject_id', subjectId)
    if (inProjects) {
      // Ids from the database, so safe to interpolate into the adapter's
      // PostgREST-style string; an empty list matches nothing.
      const any = `subject_id.in.(${inProjects.subjectIds.join(',')})`
      query = query.or(inProjects.none ? `${any},subject_id.is.null` : any)
    }
    if (assignee) {
      const owner = await resolveAssignee(assignee, actor.userId)
      if (!owner.ok) return fail(owner.code, owner.error)
      query = query.eq('assignee_user_id', owner.person.id)
    }

    if (mine) {
      query = query.eq('claimed_by', actor.actorId)
      /**
       * And this session, when the caller can name one.
       *
       * `claimed_by` is an actorLabel shared by every Claude Code session on a
       * machine, so on its own `--mine` answers "this human's agents" while
       * reading like "this session". Four sessions run here at once.
       *
       * A claim with no session is still the caller's: it predates the column
       * or came from a runtime that cannot name itself, and "cannot tell" must
       * not become "not yours" — the same rule the release guard and `croft
       * next` follow.
       *
       * Interpolated into the expression rather than parameterised because the
       * adapter's `or` takes a PostgREST string. Safe because `sessionId` is
       * matched against /^[A-Za-z0-9._:-]+$/ at authentication and is null if
       * it does not fit; nothing else reaches here.
       */
      if (actor.sessionId) {
        query = query.or(`claimed_session.is.null,claimed_session.eq.${actor.sessionId}`)
      }
    }

    const { data, error, count } = await query
      .order('position')
      .order('number', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) return failFromDb(error)
    return ok({
      count,
      offset,
      limit,
      // `subject_ref` for the CLI's pairing; `subject` (ref, title, lab project) for the lab's lists.
      tasks: await withTaskSubjects(await withAssignees(withHandoffs(withSubjectRefs(data ?? [])) as unknown as (Record<string, unknown> & { id: string })[]), actor.userId),
    })
  },
})

/**
 * Croft holds lab work: a todo belongs to a subject. A new task here is either
 * a sub-task, which takes its parent's subject, or refused with
 * `subject_required` (a subject's todos are filed through the subject).
 */
export const POST = route<{ id: string }, z.infer<typeof createTaskSchema>>({
  schema: createTaskSchema,
  secretFields: ['title', 'description'],
  handler: async ({ actor, params, body }) => {
    const project = await resolveProject<{ id: string; key: string; status: string }>(params.id, 'id, key, status')
    if (!project) return fail('not_found', `No project ${params.id}.`)

    const parent = body.parentRef ? await findTask(actor, body.parentRef, 'id, subject_id') : null
    if (body.parentRef && !parent) return fail('not_found', `No task ${body.parentRef}.`)
    const subjectId = (parent?.subject_id as string | null | undefined) ?? null
    if (!subjectId) {
      return fail(
        'subject_required',
        'Croft holds lab work: a todo belongs to a subject. File it under one (croft subject todo S-12 "<title>"), ' +
          'or track it in your task tracker.',
      )
    }

    const created = await createTaskInProject(actor, project, body, { subjectId })
    if (!created.ok) return created.response
    return ok(created.task, { status: 201 })
  },
})

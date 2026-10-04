import type { z } from 'zod'
import { admin } from '@/lib/db/client'
import type { Actor } from './auth'
import { failFromDb } from './db-errors'
import { resolveAssignee } from './people'
import { fail } from './response'
import { refuseUnreadableBody } from './task-body'
import { findTask } from './tasks'
import type { createTaskSchema } from '@/schemas/task'

export type CreateTaskInput = z.infer<typeof createTaskSchema>

export type CreatedTask = {
  id: string
  number: number
  title: string
  type: string
  status: string
  priority: string
  labels: string[]
  assignee_user_id: string
  subject_id: string | null
  created_at: string
  updated_at: string
  claimed_by: string | null
  handoff: null
  cairn_ref: null
  cairn_status: null
  assignee: { id: string; name: string; email: string; active: boolean }
  ref: string
}

/**
 * Files a task in a project. The one path every creator goes through — the
 * project route, and a subject's todo list — so the archived-project rule, the
 * readable-body rule, the assignee default and the `created` activity event
 * cannot be skipped by whichever caller was written second.
 */
export const createTaskInProject = async (
  actor: Actor,
  project: { id: string; key: string; status: string },
  body: CreateTaskInput,
  extra: { subjectId?: string | null; retry?: string } = {},
): Promise<{ ok: true; task: CreatedTask } | { ok: false; response: Response }> => {
  // Same rule as writing to an existing task (F1): a project archived here
  // is most likely the copy a move to another instance left behind, and a
  // stale-cached CLI filing a new task into it would strand the task the
  // same way a claim or a note would.
  if (project.status === 'archived') {
    return {
      ok: false,
      response: fail(
        'conflict',
        `${project.key} is archived — most likely because it moved to another Croft instance and ` +
          `this is the copy left behind. If it moved, point the CLI at the other one with ` +
          `--instance <the other instance>. To file work here instead, restore ${project.key} first: ` +
          `\`croft project restore ${project.key}\`.`,
        { project: project.key, projectStatus: 'archived' },
      ),
    }
  }

  const retry = extra.retry ?? `croft add "<title>" --project ${project.key} --body -`
  const unreadable = refuseUnreadableBody(actor, body.description, retry)
  if (unreadable) return { ok: false, response: unreadable }

  // A new task has no id yet, so it cannot be its own ancestor — the cycle
  // walk that re-parenting needs is unnecessary here.
  let parentId: string | null = null
  if (body.parentRef) {
    const parent = await findTask(actor, body.parentRef, 'id')
    if (!parent) return { ok: false, response: fail('not_found', `No task ${body.parentRef}.`) }
    parentId = parent.id
  }

  const owner = await resolveAssignee(body.assignee ?? 'me', actor.userId)
  if (!owner.ok) return { ok: false, response: fail(owner.code, owner.error) }

  const { data, error } = await admin()
    .from('tasks')
    .insert({
      project_id: project.id,
      parent_id: parentId,
      title: body.title,
      description: body.description ?? null,
      type: body.type,
      status: body.status,
      priority: body.priority,
      labels: body.labels,
      due_date: body.dueDate ?? null,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      assignee_user_id: owner.person.id,
      ...(extra.subjectId ? { subject_id: extra.subjectId } : {}),
    })
    .select(
      'id, number, title, type, status, priority, labels, assignee_user_id, subject_id, ' +
        'claimed_by, created_at, updated_at',
    )
    .single()

  if (error) return { ok: false, response: failFromDb(error) }

  await admin().from('task_activity_events').insert({
    owner_user_id: actor.userId,
    project_id: project.id,
    task_id: data.id,
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    event: 'created',
    data: { type: body.type, status: body.status, assignee: owner.person.name, ...(actor.host ? { host: actor.host } : {}) },
  })

  return {
    ok: true,
    task: {
      ...(data as unknown as Omit<CreatedTask, 'assignee' | 'ref' | 'handoff' | 'cairn_ref' | 'cairn_status'>),
      handoff: null,
      cairn_ref: null,
      cairn_status: null,
      assignee: owner.person,
      ref: `${project.key}-${data.number}`,
    },
  }
}

import type { Pool, PoolClient } from 'pg'
import { normalizeDatabaseValue, pool, transaction } from '@/lib/db/client'
import type { LabProject, Stage, StageCategory, Tag } from '@/lib/lab/types'
import type { Actor } from './auth'
import { fail } from './response'

/**
 * The board's furniture: stages (the lanes), tags (the curated filter) and
 * lab projects (which effort a subject is part of).
 * Everyone reads them; only an administrator changes them, because a lane
 * renamed or deleted moves every subject in it for the whole group.
 */

type Db = Pool | PoolClient

export type Outcome<T> = { ok: true; value: T } | { ok: false; response: Response }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: string) => UUID.test(value)

/**
 * Administrators, by role — a human session or an agent key its admin owns.
 * Stages and tags are shared configuration, not credentials, so an admin's
 * agent keeping them tidy is fine.
 */
export const isLabAdmin = (actor: Pick<Actor, 'role'>) => actor.role === 'admin'

export const refuseNonAdmin = (actor: Pick<Actor, 'role'>, what: string): Response | null =>
  isLabAdmin(actor) ? null : fail('forbidden', `Only an administrator can change ${what}.`)

const rows = <T>(result: { rows: unknown[] }) => normalizeDatabaseValue(result.rows) as T[]

const isUniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

const STAGE_COLUMNS = 'id, name, color, category, position'

export const listStages = async (db: Db = pool()): Promise<Stage[]> =>
  rows<Stage>(await db.query(`select ${STAGE_COLUMNS} from subject_stages order by position, name`))

/** A stage by id, or by name in any case. */
export const findStage = async (ref: string, db: Db = pool()): Promise<Stage | null> => {
  const value = ref.trim()
  const result = isUuid(value)
    ? await db.query(`select ${STAGE_COLUMNS} from subject_stages where id = $1`, [value])
    : await db.query(`select ${STAGE_COLUMNS} from subject_stages where lower(name) = lower($1)`, [value])
  return rows<Stage>(result)[0] ?? null
}

/** Where a new subject lands: the first planned lane, or failing that the first lane. */
export const defaultStage = async (db: Db = pool()): Promise<Stage | null> => {
  const result = await db.query(
    `select ${STAGE_COLUMNS} from subject_stages
      order by (category = 'planned') desc, position, name
      limit 1`,
  )
  return rows<Stage>(result)[0] ?? null
}

export const unknownStage = async (ref: string) => {
  const stages = await listStages()
  return fail('validation_failed', `No stage ${ref}. Valid: ${stages.map((s) => s.name).join(' | ')}.`, {
    valid: stages.map((s) => s.name),
  })
}

export const createStage = async (input: {
  name: string
  category: StageCategory
  color?: string
  position?: number
}): Promise<Outcome<Stage>> => {
  try {
    const result = await pool().query(
      `insert into subject_stages (name, category, color, position)
       values ($1, $2, coalesce($3, '#8a8792'),
               coalesce($4, (select coalesce(max(position) + 1, 0) from subject_stages)))
       returning ${STAGE_COLUMNS}`,
      [input.name, input.category, input.color ?? null, input.position ?? null],
    )
    return { ok: true, value: rows<Stage>(result)[0]! }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: fail('conflict', `A stage called ${input.name} already exists.`) }
    throw error
  }
}

export const updateStage = async (
  id: string,
  patch: { name?: string; category?: StageCategory; color?: string; position?: number },
): Promise<Outcome<Stage>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No stage ${id}.`) }
  try {
    const result = await pool().query(
      `update subject_stages set
         name     = coalesce($2, name),
         category = coalesce($3, category),
         color    = coalesce($4, color),
         position = coalesce($5, position)
       where id = $1
       returning ${STAGE_COLUMNS}`,
      [id, patch.name ?? null, patch.category ?? null, patch.color ?? null, patch.position ?? null],
    )
    const stage = rows<Stage>(result)[0]
    return stage ? { ok: true, value: stage } : { ok: false, response: fail('not_found', `No stage ${id}.`) }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: fail('conflict', `A stage called ${patch.name} already exists.`) }
    throw error
  }
}

/**
 * Refused while any subject — archived ones included — sits in the lane.
 * Deleting it would have to put them somewhere, and guessing where is worse
 * than asking the admin to move them first.
 */
export const deleteStage = async (id: string): Promise<Outcome<{ id: string; deleted: true }>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No stage ${id}.`) }
  return transaction(async (client) => {
    const stage = rows<Stage>(await client.query(`select ${STAGE_COLUMNS} from subject_stages where id = $1 for update`, [id]))[0]
    if (!stage) return { ok: false, response: fail('not_found', `No stage ${id}.`) }

    const inUse = Number(
      rows<{ n: number }>(await client.query('select count(*)::int as n from subjects where stage_id = $1', [id]))[0]?.n ?? 0,
    )
    if (inUse > 0) {
      return {
        ok: false,
        response: fail(
          'stage_in_use',
          `${inUse} subject${inUse === 1 ? '' : 's'} (archived ones included) ${inUse === 1 ? 'is' : 'are'} in ${stage.name}. Move them to another stage first.`,
          { subjects: inUse },
        ),
      }
    }

    const remaining = Number(rows<{ n: number }>(await client.query('select count(*)::int as n from subject_stages'))[0]?.n ?? 0)
    if (remaining <= 1) {
      return { ok: false, response: fail('conflict', 'The board needs at least one stage.') }
    }

    await client.query('delete from subject_stages where id = $1', [id])
    return { ok: true, value: { id, deleted: true as const } }
  })
}

/** `ids` must name every stage exactly once; the order given becomes the order. */
export const reorderStages = async (ids: string[]): Promise<Outcome<Stage[]>> =>
  transaction(async (client) => {
    const current = rows<{ id: string }>(await client.query('select id from subject_stages for update'))
    const known = new Set(current.map((s) => s.id))
    const given = new Set(ids)
    if (given.size !== ids.length || given.size !== known.size || ids.some((id) => !known.has(id))) {
      return {
        ok: false,
        response: fail('validation_failed', `Send every stage id exactly once (${known.size} stages).`),
      }
    }
    await client.query(
      `update subject_stages s set position = o.ord - 1
         from unnest($1::uuid[]) with ordinality as o(id, ord)
        where s.id = o.id`,
      [ids],
    )
    return { ok: true, value: await listStages(client) }
  })

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const TAG_COLUMNS = 'id, name, color, position'

export const listTags = async (db: Db = pool()): Promise<Tag[]> =>
  rows<Tag>(await db.query(`select ${TAG_COLUMNS} from tags order by position, name`))

/** Tags by name (any case) or id. Unknown ones are returned so the caller can say which. */
export const findTags = async (
  refs: readonly string[],
  db: Db = pool(),
): Promise<{ tags: Tag[]; unknown: string[] }> => {
  const wanted = [...new Set(refs.map((r) => r.trim()).filter(Boolean))]
  if (wanted.length === 0) return { tags: [], unknown: [] }
  const result = await db.query(
    `select ${TAG_COLUMNS} from tags
      where name = any($1::text[]) or id::text = any($2::text[])`,
    [wanted.map((r) => r.toLowerCase()), wanted],
  )
  const tags = rows<Tag>(result)
  const unknown = wanted.filter((ref) => !tags.some((t) => t.id === ref || t.name === ref.toLowerCase()))
  return { tags, unknown }
}

export const unknownTags = async (unknown: string[]) => {
  const tags = await listTags()
  return fail(
    'validation_failed',
    `No tag ${unknown.join(', ')}. Tags are curated by an administrator. Valid: ${tags.map((t) => t.name).join(' | ') || '(none yet)'}.`,
    { valid: tags.map((t) => t.name) },
  )
}

export const createTag = async (input: { name: string; color?: string; position?: number }): Promise<Outcome<Tag>> => {
  try {
    const result = await pool().query(
      `insert into tags (name, color, position)
       values ($1, coalesce($2, '#8a8792'), coalesce($3, (select coalesce(max(position) + 1, 0) from tags)))
       returning ${TAG_COLUMNS}`,
      [input.name, input.color ?? null, input.position ?? null],
    )
    return { ok: true, value: rows<Tag>(result)[0]! }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: fail('conflict', `A tag called ${input.name} already exists.`) }
    throw error
  }
}

export const updateTag = async (
  id: string,
  patch: { name?: string; color?: string; position?: number },
): Promise<Outcome<Tag>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No tag ${id}.`) }
  try {
    const result = await pool().query(
      `update tags set
         name     = coalesce($2, name),
         color    = coalesce($3, color),
         position = coalesce($4, position)
       where id = $1
       returning ${TAG_COLUMNS}`,
      [id, patch.name ?? null, patch.color ?? null, patch.position ?? null],
    )
    const tag = rows<Tag>(result)[0]
    return tag ? { ok: true, value: tag } : { ok: false, response: fail('not_found', `No tag ${id}.`) }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: fail('conflict', `A tag called ${patch.name} already exists.`) }
    throw error
  }
}

/** Deleting a tag takes it off every subject; the subjects themselves are untouched. */
export const deleteTag = async (id: string): Promise<Outcome<{ id: string; deleted: true; subjects: number }>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No tag ${id}.`) }
  return transaction(async (client) => {
    const used = Number(
      rows<{ n: number }>(await client.query('select count(*)::int as n from subject_tags where tag_id = $1', [id]))[0]?.n ?? 0,
    )
    const result = await client.query('delete from tags where id = $1', [id])
    if (!result.rowCount) return { ok: false, response: fail('not_found', `No tag ${id}.`) }
    return { ok: true, value: { id, deleted: true as const, subjects: used } }
  })
}

// ---------------------------------------------------------------------------
// Lab projects: which effort a subject is part of (Trig, Croft, Dispofi…),
// and the tracker and target its todos go to on `croft handoff`. Curated like tags.
// Not the task `projects` table: todos stay `T-n` whatever their subject's
// lab project, because per-project refs would collide with a tracker's keys.
// ---------------------------------------------------------------------------

const LAB_PROJECT_COLUMNS = 'id, name, color, handoff_tracker, handoff_target, position'

/** A lab project with how many subjects (archived ones included) are in it. */
export type LabProjectListed = LabProject & { subjects: number }

/**
 * Lab projects in order, each with how many subjects `viewerId` can see in it
 * — a count that included somebody else's private subjects would say they
 * exist. `null` counts every subject: only for the refusal that lists names.
 */
export const listLabProjects = async (viewerId: string | null, db: Db = pool()): Promise<LabProjectListed[]> =>
  rows<LabProjectListed>(
    await db.query(
      `select lp.id, lp.name, lp.color, lp.handoff_tracker, lp.handoff_target, lp.position,
              (select count(*) from subjects s
                where s.project_id = lp.id
                  and ($1::uuid is null or croft_subject_visible(s.id, $1::uuid)))::int as subjects
         from lab_projects lp
        where lp.archived_at is null
        order by lp.position, lower(lp.name)`,
      [viewerId],
    ),
  )

/** A lab project by id, or by name in any case. */
export const findLabProject = async (ref: string, db: Db = pool()): Promise<LabProject | null> => {
  const value = ref.trim()
  const result = isUuid(value)
    ? await db.query(`select ${LAB_PROJECT_COLUMNS} from lab_projects where id = $1`, [value])
    : await db.query(`select ${LAB_PROJECT_COLUMNS} from lab_projects where lower(name) = lower($1)`, [value])
  return rows<LabProject>(result)[0] ?? null
}

export const unknownLabProject = async (ref: string) => {
  const projects = await listLabProjects(null)
  return fail(
    'validation_failed',
    `No lab project ${ref}. Lab projects are curated by an administrator. ` +
      `Valid: ${projects.map((p) => p.name).join(' | ') || '(none yet)'}.`,
    { valid: projects.map((p) => p.name) },
  )
}

const projectNameTaken = (name: string | undefined) =>
  fail('conflict', `A lab project called ${name} already exists.`)

export const createLabProject = async (input: {
  name: string
  color?: string
  handoff?: { tracker: string; target: string } | null
  position?: number
}): Promise<Outcome<LabProject>> => {
  try {
    const result = await pool().query(
      `insert into lab_projects (name, color, handoff_tracker, handoff_target, position)
       values ($1, coalesce($2, '#8a8792'), $3, $4,
               coalesce($5, (select coalesce(max(position) + 1, 0) from lab_projects)))
       returning ${LAB_PROJECT_COLUMNS}`,
      [input.name, input.color ?? null, input.handoff?.tracker ?? null, input.handoff?.target ?? null, input.position ?? null],
    )
    return { ok: true, value: rows<LabProject>(result)[0]! }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: projectNameTaken(input.name) }
    throw error
  }
}

/** `handoff: null` clears the hand-off; omitted leaves it. */
export const updateLabProject = async (
  id: string,
  patch: { name?: string; color?: string; handoff?: { tracker: string; target: string } | null; position?: number },
): Promise<Outcome<LabProject>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No lab project ${id}.`) }
  try {
    const result = await pool().query(
      `update lab_projects set
         name            = coalesce($2, name),
         color           = coalesce($3, color),
         handoff_tracker = case when $4::boolean then $5::text else handoff_tracker end,
         handoff_target  = case when $4::boolean then $6::text else handoff_target end,
         position        = coalesce($7, position)
       where id = $1
       returning ${LAB_PROJECT_COLUMNS}`,
      [
        id,
        patch.name ?? null,
        patch.color ?? null,
        patch.handoff !== undefined,
        patch.handoff?.tracker ?? null,
        patch.handoff?.target ?? null,
        patch.position ?? null,
      ],
    )
    const project = rows<LabProject>(result)[0]
    return project ? { ok: true, value: project } : { ok: false, response: fail('not_found', `No lab project ${id}.`) }
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, response: projectNameTaken(patch.name) }
    throw error
  }
}

/**
 * Refused while any subject — archived ones included — is in the project,
 * as a stage is: taking it off them silently would lose the grouping, and
 * which project they belong to instead is the admin's call.
 */
export const deleteLabProject = async (id: string): Promise<Outcome<{ id: string; deleted: true }>> => {
  if (!isUuid(id)) return { ok: false, response: fail('not_found', `No lab project ${id}.`) }
  return transaction(async (client) => {
    const project = rows<LabProject>(
      await client.query(`select ${LAB_PROJECT_COLUMNS} from lab_projects where id = $1 for update`, [id]),
    )[0]
    if (!project) return { ok: false, response: fail('not_found', `No lab project ${id}.`) }

    const inUse = Number(
      rows<{ n: number }>(await client.query('select count(*)::int as n from subjects where project_id = $1', [id]))[0]?.n ?? 0,
    )
    if (inUse > 0) {
      return {
        ok: false,
        response: fail(
          'project_in_use',
          `${inUse} subject${inUse === 1 ? '' : 's'} (archived ones included) ${inUse === 1 ? 'is' : 'are'} in ${project.name}. ` +
            'Move them to another project, or to none, first.',
          { subjects: inUse },
        ),
      }
    }

    await client.query('delete from lab_projects where id = $1', [id])
    return { ok: true, value: { id, deleted: true as const } }
  })
}

/** `ids` must name every lab project exactly once; the order given becomes the order. */
export const reorderLabProjects = async (ids: string[], viewerId: string): Promise<Outcome<LabProjectListed[]>> =>
  transaction(async (client) => {
    const current = rows<{ id: string }>(
      await client.query('select id from lab_projects where archived_at is null for update'),
    )
    const known = new Set(current.map((p) => p.id))
    const given = new Set(ids)
    if (given.size !== ids.length || given.size !== known.size || ids.some((id) => !known.has(id))) {
      return {
        ok: false,
        response: fail('validation_failed', `Send every lab project id exactly once (${known.size} projects).`),
      }
    }
    await client.query(
      `update lab_projects p set position = o.ord - 1
         from unnest($1::uuid[]) with ordinality as o(id, ord)
        where p.id = o.id`,
      [ids],
    )
    return { ok: true, value: await listLabProjects(viewerId, client) }
  })

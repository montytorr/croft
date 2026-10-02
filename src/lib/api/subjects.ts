import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { normalizeDatabaseValue, pool, transaction } from '@/lib/db/client'
import {
  isConcluding,
  parseSubjectRef,
  subjectRef,
  TODO_PROJECT_KEY,
  type Stage,
  type StageCategory,
  type Subject,
  type SubjectNote,
  type SubjectNoteKind,
  type SubjectSummary,
  type SubjectTodo,
  type SubjectVisibility,
  type Tag,
} from '@/lib/lab/types'
import { removeAttachments } from '@/lib/attachments'
import { canDeleteSubject } from '@/lib/lab/ui-subject-delete'
import { createTaskSchema } from '@/schemas/task'
import type { Actor } from './auth'
import {
  defaultStage,
  findLabProject,
  findStage,
  findTags,
  isUuid,
  unknownLabProject,
  unknownStage,
  unknownTags,
  type Outcome,
} from './lab-admin'
import { resolveAssignee, type Person } from './people'
import { fail, failValidation } from './response'
import { createTaskInProject } from './task-create'
import { recordActivity } from './activity'
import { subjectVisibleSql } from './visibility'

type Db = Pool | PoolClient

const rows = <T>(result: { rows: unknown[] }) => normalizeDatabaseValue(result.rows) as T[]

// ---------------------------------------------------------------------------
// Rules, kept pure so they can be tested without a database.
// ---------------------------------------------------------------------------

/**
 * A subject entering a completed or dropped stage must say what was learned.
 *
 * Checked only when the caller moves the stage or touches the conclusion: a
 * subject already sitting in a concluding lane without one (an admin changed
 * the lane's category afterwards) can still have its title fixed.
 */
export const conclusionMissing = (input: {
  stageChanging: boolean
  conclusionTouched: boolean
  targetCategory: StageCategory
  conclusion: string | null | undefined
}): boolean =>
  (input.stageChanging || input.conclusionTouched) &&
  isConcluding(input.targetCategory) &&
  !(input.conclusion ?? '').trim()

/**
 * When the subject was concluded. Set on the way into a concluding lane,
 * cleared on the way out, left alone otherwise.
 */
export const nextConcludedAt = (input: {
  fromCategory: StageCategory
  toCategory: StageCategory
  concludedAt: string | null
  now: string
}): string | null => {
  const wasConcluded = isConcluding(input.fromCategory)
  const isConcluded = isConcluding(input.toCategory)
  if (!isConcluded) return null
  if (!wasConcluded) return input.now
  return input.concludedAt ?? input.now
}

/** `to explore → exploring` */
export const stageNoteText = (from: string, to: string) => `${from} → ${to}`

/**
 * The idempotency key of a written note: the same kind and text posted twice
 * (a retry after a timeout) is one note. Same shape as task notes.
 */
export const noteContentHash = (kind: string, note: string) =>
  createHash('sha256').update(`${kind}\n${note}`, 'utf8').digest('hex').slice(0, 32)

/**
 * Stage notes are never deduplicated — moving A → B, back, and to B again is
 * three moves — so their hash carries the moment as well.
 */
export const stageNoteHash = (from: string, to: string, at: string) =>
  createHash('sha256').update(`stage\n${from}\n${to}\n${at}`, 'utf8').digest('hex').slice(0, 32)

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SUBJECT_SELECT = `
  select s.id, s.number, s.title, s.body, s.conclusion, s.concluded_at, s.position,
         s.actor_id, s.created_at, s.updated_at, s.archived_at, s.visibility,
         coalesce((
           select json_agg(json_build_object('id', mu.id, 'name', coalesce(nullif(trim(mp.display_name), ''), mu.email))
                           order by lower(coalesce(nullif(trim(mp.display_name), ''), mu.email)))
             from subject_members m
             join app_users mu on mu.id = m.user_id
             left join user_profiles mp on mp.id = mu.id
            where m.subject_id = s.id
         ), '[]'::json) as members,
         json_build_object('id', st.id, 'name', st.name, 'color', st.color,
                           'category', st.category, 'position', st.position) as stage,
         coalesce((
           select json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color, 'position', t.position)
                           order by t.position, t.name)
             from subject_tags x
             join tags t on t.id = x.tag_id
            where x.subject_id = s.id
         ), '[]'::json) as tags,
         case when lp.id is null then null
              else json_build_object('id', lp.id, 'name', lp.name, 'color', lp.color,
                                     'cairn_key', lp.cairn_key, 'position', lp.position)
         end as project,
         case when u.id is null then null
              else json_build_object('id', u.id, 'name', coalesce(nullif(trim(p.display_name), ''), u.email))
         end as owner,
         (select count(*) from tasks k where k.subject_id = s.id and k.status not in ('done', 'cancelled'))::int as todos_open,
         (select count(*) from tasks k where k.subject_id = s.id and k.status = 'done')::int as todos_done
    from subjects s
    join subject_stages st on st.id = s.stage_id
    left join lab_projects lp on lp.id = s.project_id
    left join app_users u on u.id = s.owner_user_id
    left join user_profiles p on p.id = u.id`

type SubjectRow = Omit<Subject, 'ref' | 'todos'> & { todos_open: number; todos_done: number }

const toSubject = (row: SubjectRow): Subject => {
  const { todos_open, todos_done, ...rest } = row
  return { ...rest, ref: subjectRef(row.number), todos: { open: todos_open, done: todos_done } }
}

/** A board card: everything but the write-up, which can run to pages. */
const toSummary = (row: SubjectRow): SubjectSummary => {
  const summary: Partial<Subject> = toSubject(row)
  delete summary.body
  delete summary.concluded_at
  return summary as SubjectSummary
}

export type SubjectFilters = {
  /** Stage name (any case) or id. */
  stage?: string
  /** Tag name (any case) or id, or a comma list of them: subjects carrying any. */
  tag?: string
  ownerId?: string
  /**
   * Lab project name (any case) or id, `none` for subjects in no project, or
   * a comma list of them: subjects in any.
   */
  project?: string
  q?: string
  /**
   * `'include'`: live and archived. `'only'` or `true`: archived only.
   * Anything else: live only.
   */
  archived?: boolean | 'exclude' | 'include' | 'only'
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * The board: lanes in order, then each lane's own order. Only the subjects
 * `viewerId` may see — a private one of somebody else's is not on it at all.
 */
export const listSubjects = async (
  filters: SubjectFilters,
  viewerId: string,
  db: Db = pool(),
): Promise<SubjectSummary[]> => {
  const archived = filters.archived === true ? 'only' : filters.archived || 'exclude'
  const values: unknown[] = [viewerId]
  const where: string[] = [subjectVisibleSql('s.id', '$1')]
  if (archived !== 'include') where.push(archived === 'only' ? 's.archived_at is not null' : 's.archived_at is null')
  const bind = (value: unknown) => {
    values.push(value)
    return `$${values.length}`
  }

  if (filters.stage) {
    const v = bind(filters.stage.trim())
    where.push(`(st.id::text = ${v} or lower(st.name) = lower(${v}))`)
  }
  const tags = (filters.tag ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  if (tags.length) {
    const v = bind(tags)
    where.push(`exists (select 1 from subject_tags x join tags t on t.id = x.tag_id
                         where x.subject_id = s.id
                           and (t.id::text = any(${v}::text[]) or t.name = any(select lower(u) from unnest(${v}::text[]) u)))`)
  }
  const projects = (filters.project ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  if (projects.length) {
    const named = projects.filter((p) => p.toLowerCase() !== 'none')
    const either: string[] = []
    if (named.length < projects.length) either.push('s.project_id is null')
    if (named.length) {
      const v = bind(named)
      either.push(`(lp.id::text = any(${v}::text[]) or lower(lp.name) = any(select lower(u) from unnest(${v}::text[]) u))`)
    }
    where.push(`(${either.join(' or ')})`)
  }
  if (filters.ownerId) {
    if (!isUuid(filters.ownerId)) return []
    where.push(`s.owner_user_id = ${bind(filters.ownerId)}::uuid`)
  }
  if (filters.q) {
    const q = bind(filters.q)
    const like = bind(`%${escapeLike(filters.q)}%`)
    where.push(`(s.search_vector @@ websearch_to_tsquery('english', ${q}) or s.title ilike ${like})`)
  }

  const result = await db.query(
    `${SUBJECT_SELECT}
      where ${where.join(' and ')}
      order by st.position, s.position, s.number desc`,
    values,
  )
  return rows<SubjectRow>(result).map(toSummary)
}

/**
 * A subject by id, or null when there is none or `viewerId` may not see it —
 * the two are the same answer on purpose.
 */
export const getSubjectById = async (id: string, viewerId: string, db: Db = pool()): Promise<Subject | null> => {
  if (!isUuid(id)) return null
  const row = rows<SubjectRow>(
    await db.query(`${SUBJECT_SELECT} where s.id = $1 and ${subjectVisibleSql('s.id', '$2')}`, [id, viewerId]),
  )[0]
  return row ? toSubject(row) : null
}

export const getSubjectByNumber = async (number: number, viewerId: string, db: Db = pool()): Promise<Subject | null> => {
  const row = rows<SubjectRow>(
    await db.query(`${SUBJECT_SELECT} where s.number = $1 and ${subjectVisibleSql('s.id', '$2')}`, [number, viewerId]),
  )[0]
  return row ? toSubject(row) : null
}

/**
 * A subject read back after the caller wrote it, whoever can see it now: an
 * owner who hands a private subject to somebody else still gets the result
 * of their own write. Never for a read the caller did not just make.
 */
const reloadSubject = async (id: string, db: Db = pool()): Promise<Subject> => {
  const row = rows<SubjectRow>(await db.query(`${SUBJECT_SELECT} where s.id = $1`, [id]))[0]
  if (!row) throw new Error(`subject ${id} vanished after a write`)
  return toSubject(row)
}

/**
 * `S-12`, `s-12`, `12` or the subject's uuid — the choke point every
 * `/subjects/[ref]` route resolves through. A subject the viewer may not see
 * resolves to null, so reads and writes alike answer `not_found`.
 */
export const resolveSubject = async (raw: string, viewerId: string): Promise<Subject | null> => {
  const value = decodeURIComponent(raw).trim()
  if (isUuid(value)) return getSubjectById(value, viewerId)
  const number = parseSubjectRef(value)
  return number === null ? null : getSubjectByNumber(number, viewerId)
}

export const noSuchSubject = (raw: string) =>
  fail('not_found', `No subject ${decodeURIComponent(raw)}. Subjects are addressed as S-12.`)

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** `undefined` → the caller; `null` → nobody; anything else → that person. */
const resolveOwner = async (
  owner: string | null | undefined,
  actor: Actor,
): Promise<Outcome<string | null>> => {
  if (owner === null) return { ok: true, value: null }
  const person = await resolveAssignee(owner ?? 'me', actor.userId)
  return person.ok ? { ok: true, value: person.person.id } : { ok: false, response: fail(person.code, person.error) }
}

const conclusionRequired = (stage: Stage, ref = 'S-<n>') =>
  fail(
    'conclusion_required',
    `${stage.name} is a ${stage.category} stage: say what was learned. Send a conclusion with the move ` +
      `(croft subject stage ${ref} "${stage.name}" --conclusion "<what we learned>").`,
    { stage: stage.name, category: stage.category },
  )

const setTags = async (client: PoolClient, subjectId: string, tags: Tag[]) => {
  await client.query('delete from subject_tags where subject_id = $1', [subjectId])
  if (tags.length === 0) return
  await client.query(
    `insert into subject_tags (subject_id, tag_id)
     select $1, unnest($2::uuid[]) on conflict do nothing`,
    [subjectId, tags.map((t) => t.id)],
  )
}

// ---------------------------------------------------------------------------
// Visibility (v0.4): who may see a subject, and who may change that.
// ---------------------------------------------------------------------------

/**
 * Who may change a non-lab subject's visibility, members or owner: its owner,
 * and nobody else — administrators included (v0.5). While the owner is
 * deactivated nobody can change who sees it: a private subject stays hidden
 * and a members subject stays with its members until the owner is restored.
 */
export const canManageSubject = async (subjectId: string, viewerId: string, db: Db = pool()): Promise<boolean> => {
  const result = await db.query<{ can: boolean }>(
    'select (s.owner_user_id = $2::uuid) as can from subjects s where s.id = $1',
    [subjectId, viewerId],
  )
  return result.rows[0]?.can === true
}

const notTheOwner = (subject: Pick<Subject, 'ref' | 'visibility'>) =>
  fail(
    'forbidden',
    `Only the owner of ${subject.ref} can change who sees it (it is ${subject.visibility}). ` +
      `Ask them to share it, or to publish it to the lab.`,
  )

const alreadyPublished = (subject: Pick<Subject, 'ref'>) =>
  fail(
    'already_published',
    `${subject.ref} is in the lab: everyone can see it, and publishing cannot be undone. ` +
      `File a new private subject for work that should stay private.`,
    { visibility: 'lab' },
  )

const ownerRequired = (visibility: SubjectVisibility) =>
  fail(
    'owner_required',
    `A ${visibility} subject needs an owner: they are the one person who can always see it. ` +
      `Name one (owner: "me"), or publish it to the lab first.`,
    { visibility },
  )

/** `published to the lab`, `made private`, `shared with Mael`. */
export const visibilityNoteText = (
  from: SubjectVisibility,
  to: SubjectVisibility,
  members: readonly { name: string }[] = [],
): string => {
  if (to === 'lab') return 'published to the lab'
  if (to === 'private') return 'made private'
  if (from === 'lab') return 'shared with its members'
  return members.length ? `shared with ${members.map((m) => m.name).join(', ')}` : 'shared with its members (none yet)'
}

/** Never deduplicated: private → members → private → members is four changes. */
export const visibilityNoteHash = (note: string, at: string) =>
  createHash('sha256').update(`visibility\n${note}\n${at}`, 'utf8').digest('hex').slice(0, 32)

const writeVisibilityNote = async (client: PoolClient, actor: Actor, subjectId: string, note: string) => {
  await client.query(
    `insert into subject_notes (subject_id, kind, note, actor_type, actor_id, user_id, content_hash)
     values ($1, 'visibility', $2, $3, $4, $5, $6)`,
    [subjectId, note, actor.actorType, actor.actorId, actor.userId, visibilityNoteHash(note, new Date().toISOString())],
  )
}

/** Each of `refs` as a person, deduplicated; the owner is dropped (owners are not listed as members). */
const resolveMembers = async (
  refs: readonly string[],
  actor: Actor,
  ownerId: string | null,
): Promise<Outcome<Person[]>> => {
  const found = new Map<string, Person>()
  for (const ref of refs) {
    const person = await resolveAssignee(ref, actor.userId)
    if (!person.ok) return { ok: false, response: fail(person.code, person.error) }
    if (person.person.id !== ownerId) found.set(person.person.id, person.person)
  }
  return { ok: true, value: [...found.values()] }
}

export type CreateSubjectInput = {
  title: string
  body?: string
  stage?: string
  tags?: string[]
  owner?: string | null
  /** A lab project by name or id; omitted or null, none. */
  project?: string | null
  conclusion?: string
  /** Omitted: `lab`, visible to everyone. */
  visibility?: SubjectVisibility
  /** Who a `members` subject is shared with: `me`, an id, an email or a display name each. */
  members?: string[]
}

/** `undefined` → leave it; `null` → none; anything else → that lab project, or a refusal listing the real ones. */
const resolveLabProject = async (ref: string | null | undefined): Promise<Outcome<string | null | undefined>> => {
  if (ref === undefined || ref === null) return { ok: true, value: ref }
  const project = await findLabProject(ref)
  return project ? { ok: true, value: project.id } : { ok: false, response: await unknownLabProject(ref) }
}

export const createSubject = async (actor: Actor, input: CreateSubjectInput): Promise<Outcome<Subject>> => {
  const visibility = input.visibility ?? 'lab'
  const memberRefs = input.members ?? []
  if (memberRefs.length && visibility !== 'members') {
    return {
      ok: false,
      response: fail(
        'validation_failed',
        visibility === 'lab'
          ? 'A lab subject is open to everyone, so it has no members. Send visibility: "members" to share it with some people only.'
          : 'A private subject is its owner\'s alone. Send visibility: "members" to share it with the people named.',
        { field: 'members', visibility },
      ),
    }
  }

  const stage = input.stage ? await findStage(input.stage) : await defaultStage()
  if (!stage) {
    return { ok: false, response: input.stage ? await unknownStage(input.stage) : fail('conflict', 'The board has no stages yet.') }
  }
  if (conclusionMissing({ stageChanging: true, conclusionTouched: true, targetCategory: stage.category, conclusion: input.conclusion })) {
    return { ok: false, response: conclusionRequired(stage) }
  }

  const { tags, unknown } = await findTags(input.tags ?? [])
  if (unknown.length) return { ok: false, response: await unknownTags(unknown) }

  const project = await resolveLabProject(input.project)
  if (!project.ok) return project

  const owner = await resolveOwner(input.owner, actor)
  if (!owner.ok) return owner

  if (visibility !== 'lab') {
    if (owner.value === null) return { ok: false, response: ownerRequired(visibility) }
    // Filing a private subject for someone else would hand the caller a
    // subject they cannot see the moment it exists.
    if (owner.value !== actor.userId) {
      return {
        ok: false,
        response: fail(
          'forbidden',
          `A ${visibility} subject is filed by its owner. Leave owner out (it is you), or file it in the lab ` +
            `and let them take it.`,
        ),
      }
    }
  }

  const members = await resolveMembers(memberRefs, actor, owner.value)
  if (!members.ok) return members

  const id = await transaction(async (client) => {
    const inserted = await client.query(
      `insert into subjects
         (title, body, stage_id, owner_user_id, conclusion, concluded_at, position, actor_type, actor_id, project_id,
          visibility)
       values ($1, $2, $3, $4, $5, $6,
               (select coalesce(max(position) + 1, 0) from subjects where stage_id = $3),
               $7, $8, $9, $10)
       returning id`,
      [
        input.title,
        input.body ?? null,
        stage.id,
        owner.value,
        input.conclusion ?? null,
        isConcluding(stage.category) ? new Date().toISOString() : null,
        actor.actorType,
        actor.actorId,
        project.value ?? null,
        visibility,
      ],
    )
    const subjectId = (inserted.rows[0] as { id: string }).id
    await setTags(client, subjectId, tags)
    if (members.value.length) {
      await client.query(
        `insert into subject_members (subject_id, user_id, added_by)
         select $1, unnest($2::uuid[]), $3 on conflict do nothing`,
        [subjectId, members.value.map((m) => m.id), actor.userId],
      )
    }
    return subjectId
  })

  return { ok: true, value: await reloadSubject(id) }
}

export type UpdateSubjectInput = {
  title?: string
  body?: string | null
  stage?: string
  conclusion?: string | null
  tags?: string[]
  owner?: string | null
  /** A lab project by name or id; `null` takes the subject out of its project. */
  project?: string | null
  position?: number
  archived?: boolean
  /**
   * `private ↔ members` freely; either → `lab` publishes, for good. `lab →`
   * anything else is refused (`already_published`). Owner only.
   */
  visibility?: SubjectVisibility
}

/**
 * Edits a subject. A stage change writes a `stage` note in the same
 * transaction, so the log can never disagree with the board; a visibility
 * change writes a `visibility` note the same way.
 *
 * The caller has already resolved `subject` through `resolveSubject`, so it
 * can see it: for a non-lab subject that is its owner and members, which is
 * exactly who may edit it. Who sees it — visibility and owner — is the
 * owner's alone (`canManageSubject`).
 */
/**
 * Whether the subject still has the visibility and owner the caller read,
 * with its row locked until the transaction ends. Who may see a subject is
 * decided from that read, and two requests can interleave: a stale "make it
 * members" landing after a publish would take a lab subject back out of the
 * lab, which publishing promises can never happen.
 */
const stillAsRead = async (client: PoolClient, subject: Pick<Subject, 'id' | 'visibility' | 'owner'>) => {
  const { rows: locked } = await client.query<{ visibility: string; owner_user_id: string | null }>(
    'select visibility, owner_user_id from subjects where id = $1 for update',
    [subject.id],
  )
  const row = locked[0]
  return Boolean(row) && row!.visibility === subject.visibility && row!.owner_user_id === (subject.owner?.id ?? null)
}

const changedMeanwhile = (subject: Pick<Subject, 'ref'>) =>
  fail('conflict', `${subject.ref} changed while this was being applied. Read it again, then retry.`)

export const updateSubject = async (
  actor: Actor,
  subject: Subject,
  patch: UpdateSubjectInput,
): Promise<Outcome<Subject>> => {
  const visibilityChanging = patch.visibility !== undefined && patch.visibility !== subject.visibility
  const targetVisibility = patch.visibility ?? subject.visibility

  if (visibilityChanging && subject.visibility === 'lab') return { ok: false, response: alreadyPublished(subject) }
  if (visibilityChanging || (patch.owner !== undefined && subject.visibility !== 'lab')) {
    if (!(await canManageSubject(subject.id, actor.userId))) return { ok: false, response: notTheOwner(subject) }
  }

  let target: Stage = subject.stage
  if (patch.stage !== undefined) {
    const found = await findStage(patch.stage)
    if (!found) return { ok: false, response: await unknownStage(patch.stage) }
    target = found
  }
  const stageChanging = target.id !== subject.stage.id
  const conclusion = patch.conclusion !== undefined ? patch.conclusion : subject.conclusion

  if (
    conclusionMissing({
      stageChanging,
      conclusionTouched: patch.conclusion !== undefined,
      targetCategory: target.category,
      conclusion,
    })
  ) {
    return { ok: false, response: conclusionRequired(target, subject.ref) }
  }

  let tags: Tag[] | undefined
  if (patch.tags !== undefined) {
    const found = await findTags(patch.tags)
    if (found.unknown.length) return { ok: false, response: await unknownTags(found.unknown) }
    tags = found.tags
  }

  const project = await resolveLabProject(patch.project)
  if (!project.ok) return project

  let ownerId: string | null | undefined
  if (patch.owner !== undefined) {
    const owner = await resolveOwner(patch.owner, actor)
    if (!owner.ok) return owner
    ownerId = owner.value
  }
  const finalOwner = ownerId !== undefined ? ownerId : (subject.owner?.id ?? null)
  if (targetVisibility !== 'lab' && finalOwner === null) {
    return { ok: false, response: ownerRequired(targetVisibility) }
  }

  const now = new Date().toISOString()
  const set: string[] = []
  const values: unknown[] = [subject.id]
  const assign = (column: string, value: unknown) => {
    values.push(value)
    set.push(`${column} = $${values.length}`)
  }

  if (patch.title !== undefined) assign('title', patch.title)
  if (patch.body !== undefined) assign('body', patch.body)
  if (patch.conclusion !== undefined) assign('conclusion', patch.conclusion)
  if (ownerId !== undefined) assign('owner_user_id', ownerId)
  if (project.value !== undefined) assign('project_id', project.value)
  if (visibilityChanging) assign('visibility', targetVisibility)
  if (patch.archived !== undefined) {
    if (patch.archived && !subject.archived_at) assign('archived_at', now)
    if (!patch.archived && subject.archived_at) assign('archived_at', null)
  }
  if (stageChanging) {
    assign('stage_id', target.id)
    const concludedAt = nextConcludedAt({
      fromCategory: subject.stage.category,
      toCategory: target.category,
      concludedAt: subject.concluded_at,
      now,
    })
    if (concludedAt !== subject.concluded_at) assign('concluded_at', concludedAt)
  } else if (patch.conclusion && isConcluding(target.category) && !subject.concluded_at) {
    assign('concluded_at', now)
  }
  if (patch.position !== undefined) {
    assign('position', patch.position)
  } else if (stageChanging) {
    values.push(target.id)
    set.push(`position = (select coalesce(max(position) + 1, 0) from subjects where stage_id = $${values.length})`)
  }

  const guarded = visibilityChanging || ownerId !== undefined
  const applied = await transaction(async (client) => {
    if (guarded && !(await stillAsRead(client, subject))) return false
    if (set.length > 0) {
      await client.query(`update subjects set ${set.join(', ')} where id = $1`, values)
    }
    if (tags !== undefined) {
      await setTags(client, subject.id, tags)
      // Tags live in another table, so the row's own trigger never saw them.
      if (set.length === 0) await client.query('update subjects set updated_at = now() where id = $1', [subject.id])
    }
    // An owner is never also listed as a member.
    if (ownerId) await client.query('delete from subject_members where subject_id = $1 and user_id = $2', [subject.id, ownerId])
    if (visibilityChanging) {
      // In the lab everyone sees it; a members list would only mislead.
      if (targetVisibility === 'lab') await client.query('delete from subject_members where subject_id = $1', [subject.id])
      await writeVisibilityNote(
        client,
        actor,
        subject.id,
        visibilityNoteText(subject.visibility, targetVisibility, subject.members.filter((m) => m.id !== ownerId)),
      )
    }
    if (stageChanging) {
      await client.query(
        `insert into subject_notes (subject_id, kind, note, actor_type, actor_id, user_id, content_hash)
         values ($1, 'stage', $2, $3, $4, $5, $6)`,
        [
          subject.id,
          stageNoteText(subject.stage.name, target.name),
          actor.actorType,
          actor.actorId,
          actor.userId,
          stageNoteHash(subject.stage.name, target.name, now),
        ],
      )
    }
    return true
  })
  if (!applied) return { ok: false, response: changedMeanwhile(subject) }

  return { ok: true, value: await reloadSubject(subject.id) }
}

/** `POST /subjects/[ref]/publish`: private or members → lab, for good. */
export const publishSubject = async (actor: Actor, subject: Subject): Promise<Outcome<Subject>> =>
  subject.visibility === 'lab'
    ? { ok: false, response: alreadyPublished(subject) }
    : updateSubject(actor, subject, { visibility: 'lab' })

export type DeletedSubject = {
  deleted: true
  ref: string
  id: string
  todosDeleted: number
  attachmentsRemoved: number
}

/** The refusal for a caller who may not delete `subject`, or null. */
export const refuseSubjectDelete = (subject: Subject, viewer: { userId: string; role: string }) =>
  canDeleteSubject(subject, viewer)
    ? null
    : fail(
        'forbidden',
        subject.visibility === 'lab'
          ? `Only the owner of ${subject.ref} or an administrator can delete it.`
          : `Only the owner of ${subject.ref} can delete it (it is ${subject.visibility}).`,
      )

/**
 * Deletes a subject for good: its todos (and their sub-todos), work log,
 * human notes, files, tags and members. A Cairn task pushed from one of its
 * todos is Cairn's, and stays.
 *
 * Every todo goes with it, never detached: a todo without a subject is
 * visible to everyone (076), so detaching would publish a private subject's
 * todos. Stored objects go before the rows, as for a single file, and under
 * the row locks so no new file can land on a todo meanwhile. Activity events
 * stay, stamped with a subject that no longer exists: the feed hides them.
 */
export const deleteSubject = async (actor: Actor, subject: Subject): Promise<Outcome<DeletedSubject>> => {
  const refused = refuseSubjectDelete(subject, actor)
  if (refused) return { ok: false, response: refused }

  return transaction(async (client) => {
    if (!(await stillAsRead(client, subject))) return { ok: false as const, response: changedMeanwhile(subject) }

    const { rows: todos } = await client.query<{ id: string }>(
      `with recursive tree as (
         select id from tasks where subject_id = $1
         union
         select t.id from tasks t join tree on t.parent_id = tree.id
       )
       select t.id from tasks t join tree using (id) for update of t`,
      [subject.id],
    )
    const todoIds = todos.map((t) => t.id)

    const { rows: files } = await client.query<{ storage_path: string }>(
      `select storage_path from subject_attachments where subject_id = $1
       union all
       select storage_path from task_attachments where task_id = any($2::uuid[])`,
      [subject.id, todoIds],
    )
    const paths = files.map((f) => f.storage_path)
    if (paths.length > 0) await removeAttachments(paths)

    await client.query('delete from tasks where id = any($1::uuid[])', [todoIds])
    await client.query('delete from subjects where id = $1', [subject.id])

    return {
      ok: true as const,
      value: { deleted: true as const, ref: subject.ref, id: subject.id, todosDeleted: todoIds.length, attachmentsRemoved: paths.length },
    }
  })
}

/**
 * Shares a subject with one more person. Sharing a private subject makes it a
 * `members` one — that is what sharing means. Owner only; a lab subject has
 * nobody to add (everyone sees it already).
 */
export const addSubjectMember = async (actor: Actor, subject: Subject, userRef: string): Promise<Outcome<Subject>> => {
  if (subject.visibility === 'lab') return { ok: false, response: alreadyPublished(subject) }
  if (!(await canManageSubject(subject.id, actor.userId))) return { ok: false, response: notTheOwner(subject) }

  const person = await resolveAssignee(userRef, actor.userId)
  if (!person.ok) return { ok: false, response: fail(person.code, person.error) }
  if (person.person.id === subject.owner?.id) {
    return {
      ok: false,
      response: fail('validation_failed', `${person.person.name} owns ${subject.ref}; an owner always sees it.`),
    }
  }

  const applied = await transaction(async (client) => {
    if (!(await stillAsRead(client, subject))) return false
    const added = await client.query(
      `insert into subject_members (subject_id, user_id, added_by) values ($1, $2, $3)
       on conflict do nothing returning user_id`,
      [subject.id, person.person.id, actor.userId],
    )
    const flipping = subject.visibility === 'private'
    if (flipping) await client.query(`update subjects set visibility = 'members' where id = $1`, [subject.id])
    if (added.rowCount || flipping) {
      await writeVisibilityNote(client, actor, subject.id, `shared with ${person.person.name}`)
    }
    return true
  })
  if (!applied) return { ok: false, response: changedMeanwhile(subject) }
  return { ok: true, value: await reloadSubject(subject.id) }
}

/**
 * Stops sharing a subject with someone. The owner removes anybody; a member
 * may remove themselves. `userRef` is an id, `me`, an email or a name — an id
 * works for a deactivated member too.
 */
export const removeSubjectMember = async (
  actor: Actor,
  subject: Subject,
  userRef: string,
): Promise<Outcome<Subject | { ref: string; left: true }>> => {
  if (subject.visibility === 'lab') return { ok: false, response: alreadyPublished(subject) }

  const value = decodeURIComponent(userRef).trim()
  const listed = subject.members.find((m) => m.id === value)
  let member: { id: string; name: string } | undefined = listed
  if (!member) {
    const person = await resolveAssignee(value, actor.userId)
    if (person.ok) member = { id: person.person.id, name: person.person.name }
    else if (!isUuid(value)) return { ok: false, response: fail(person.code, person.error) }
  }

  const self = member?.id === actor.userId
  if (!self && !(await canManageSubject(subject.id, actor.userId))) return { ok: false, response: notTheOwner(subject) }

  const removed = member
    ? await transaction(async (client) => {
        const gone = await client.query('delete from subject_members where subject_id = $1 and user_id = $2', [
          subject.id,
          member.id,
        ])
        if (gone.rowCount) await writeVisibilityNote(client, actor, subject.id, `no longer shared with ${member.name}`)
        return Boolean(gone.rowCount)
      })
    : false
  if (!removed) {
    return { ok: false, response: fail('not_found', `${member?.name ?? value} is not a member of ${subject.ref}.`) }
  }

  const after = await getSubjectById(subject.id, actor.userId)
  return { ok: true, value: after ?? { ref: subject.ref, left: true } }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

const NOTE_COLUMNS = 'id, kind, note, actor_type, actor_id, created_at'

/** Newest first, like a task's notes. */
export const listSubjectNotes = async (
  subjectId: string,
  options: { kind?: SubjectNoteKind; limit?: number } = {},
): Promise<SubjectNote[]> => {
  const result = await pool().query(
    `select ${NOTE_COLUMNS} from subject_notes
      where subject_id = $1 and ($2::text is null or kind = $2)
      order by created_at desc, id desc
      limit $3`,
    [subjectId, options.kind ?? null, options.limit ?? 500],
  )
  return rows<SubjectNote>(result)
}

/**
 * Appends to the work log. Idempotent on (subject, kind + text): a retry
 * returns `duplicate: true` and writes nothing.
 */
export const addSubjectNote = async (
  actor: Actor,
  subjectId: string,
  input: { note: string; kind: SubjectNoteKind },
  contentHash = noteContentHash(input.kind, input.note),
): Promise<{ note: SubjectNote | null; duplicate: boolean }> => {
  const result = await pool().query(
    `insert into subject_notes (subject_id, kind, note, actor_type, actor_id, user_id, content_hash)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (subject_id, content_hash) do nothing
     returning ${NOTE_COLUMNS}`,
    [subjectId, input.kind, input.note, actor.actorType, actor.actorId, actor.userId, contentHash],
  )
  const note = rows<SubjectNote>(result)[0] ?? null
  return { note, duplicate: note === null }
}

// ---------------------------------------------------------------------------
// Todos: ordinary tasks in the `T` project, pointed at their subject.
// ---------------------------------------------------------------------------

type TodoRow = Omit<SubjectTodo, 'ref'> & { key: string }

/** Open ones first, then the order the project's list uses. */
export const listSubjectTodos = async (subjectId: string): Promise<SubjectTodo[]> => {
  const result = await pool().query(
    `select t.id, t.number, p.key, t.title, t.status, t.claimed_by, t.cairn_ref, t.cairn_status, t.updated_at
       from tasks t
       join projects p on p.id = t.project_id
      where t.subject_id = $1
      order by (t.status in ('done', 'cancelled')), t.position, t.number`,
    [subjectId],
  )
  return rows<TodoRow>(result).map(({ key, ...todo }) => ({ ...todo, ref: `${key}-${todo.number}` }))
}

type TodoProject = { id: string; key: string; status: string }

/**
 * The system project todos live in, created on first use. Owned by whoever
 * files the first todo — projects need an owner, and there is no system user.
 */
export const ensureTodoProject = async (actor: Actor): Promise<TodoProject> => {
  const existing = async () =>
    rows<TodoProject>(await pool().query('select id, key, status from projects where key = $1', [TODO_PROJECT_KEY]))[0]

  const found = await existing()
  if (found) return found

  const created = rows<TodoProject>(
    await pool().query(
      `insert into projects (owner_user_id, key, title, description)
       values ($1, $2, 'Todos', 'Todos for lab subjects. Created by Croft; every task here belongs to a subject.')
       on conflict (key) do nothing
       returning id, key, status`,
      [actor.userId, TODO_PROJECT_KEY],
    ),
  )[0]
  if (created) {
    await recordActivity(
      [
        {
          project_id: created.id,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          event: 'project_created',
          data: { key: TODO_PROJECT_KEY, title: 'Todos' },
        },
      ],
      actor.userId,
      actor.host,
    )
    return created
  }
  // Lost a race with another first todo: theirs is the project.
  const raced = await existing()
  if (!raced) throw new Error('todo project could not be created')
  return raced
}

export type CreateTodoInput = {
  title: string
  description?: string
  priority: string
  type: string
  status: string
  assignee?: string
}

/**
 * Files a todo through the same path every task takes — the create schema's
 * rules, the readable-body rule, numbering, the `created` event — so a todo
 * is a task in every respect but its subject.
 */
export const createSubjectTodo = async (
  actor: Actor,
  subject: Pick<Subject, 'id' | 'ref'>,
  input: CreateTodoInput,
): Promise<Outcome<SubjectTodo & { assignee: { id: string; name: string } }>> => {
  const parsed = createTaskSchema.safeParse({
    title: input.title,
    description: input.description,
    priority: input.priority,
    type: input.type,
    status: input.status,
    assignee: input.assignee,
  })
  if (!parsed.success) return { ok: false, response: failValidation(parsed.error.issues) }

  const project = await ensureTodoProject(actor)
  const created = await createTaskInProject(actor, project, parsed.data, {
    subjectId: subject.id,
    retry: `croft subject todo ${subject.ref} "<title>" --body -`,
  })
  if (!created.ok) return created

  const task = created.task
  return {
    ok: true,
    value: {
      id: task.id,
      ref: task.ref,
      number: task.number,
      title: task.title,
      status: task.status,
      claimed_by: task.claimed_by,
      cairn_ref: task.cairn_ref,
      cairn_status: task.cairn_status,
      updated_at: task.updated_at,
      assignee: { id: task.assignee.id, name: task.assignee.name },
    },
  }
}

// ---------------------------------------------------------------------------
// The briefing
// ---------------------------------------------------------------------------

export type SubjectBrief = {
  counts: Record<string, number>
  mine: SubjectSummary[]
}

/**
 * What a session start needs to know: how full each lane is, and at most
 * three live subjects the caller's human owns — active ones before planned.
 */
export const subjectBrief = async (userId: string): Promise<SubjectBrief> => {
  // Counted as the caller sees the board: a lane holding only somebody
  // else's private subjects reads as empty.
  const countRows = rows<{ name: string; n: number }>(
    await pool().query(
      `select st.name, count(s.id)::int as n
         from subject_stages st
         left join subjects s on s.stage_id = st.id and s.archived_at is null
                             and ${subjectVisibleSql('s.id', '$1')}
        group by st.id, st.name, st.position
        order by st.position, st.name`,
      [userId],
    ),
  )
  const counts = Object.fromEntries(countRows.map((r) => [r.name, r.n]))

  const mine = rows<SubjectRow>(
    await pool().query(
      `${SUBJECT_SELECT}
        where s.archived_at is null
          and s.owner_user_id = $1
          and ${subjectVisibleSql('s.id', '$1')}
          and st.category in ('active', 'planned')
        order by (st.category = 'active') desc, s.updated_at desc
        limit 3`,
      [userId],
    ),
  ).map(toSummary)

  return { counts, mine }
}

/** Used by search: the subject an `S-12` query names, if it exists and `viewerId` may see it. */
export const subjectByRefQuery = async (q: string, viewerId: string): Promise<Subject | null> => {
  const match = /^\s*[Ss]-(\d{1,7})\s*$/.exec(q)
  return match ? getSubjectByNumber(Number(match[1]), viewerId) : null
}

import { z } from 'zod'
import { STAGE_CATEGORIES, SUBJECT_NOTE_KINDS, SUBJECT_VISIBILITIES } from '@/lib/lab/types'
import { taskPriority, taskStatus, taskType } from './task'

/**
 * Kinds a caller may write. `stage` and `visibility` are the server's own:
 * written on every stage move and every publish or share, and one posted by
 * hand would put a move — or a "published to the lab" — in the history that
 * never happened.
 */
export const WRITABLE_NOTE_KINDS = SUBJECT_NOTE_KINDS.filter(
  (kind): kind is Exclude<(typeof SUBJECT_NOTE_KINDS)[number], 'stage' | 'visibility'> =>
    kind !== 'stage' && kind !== 'visibility',
)

const HEX = /^#[0-9a-fA-F]{6}$/
const colour = z.string().regex(HEX, 'Use a six-digit hex colour, like #6b7fa6.').transform((v) => v.toLowerCase())

const title = z.string().trim().min(1).max(300)
const body = z.string().max(200_000)
const conclusion = z.string().trim().min(1).max(20_000)
/** A stage by name (`exploring`, any case) or id. */
const stageRef = z.string().trim().min(1).max(80)
/** Tag names. Unknown names are refused by the route, which lists the real ones. */
const tagNames = z.array(z.string().trim().min(1).max(40)).max(20)
/** `me`, a user id, an email or a display name. */
const owner = z.string().trim().min(1).max(320)
/** A lab project by name (any case) or id. Unknown ones are refused by the route, which lists the real ones. */
const projectRef = z.string().trim().min(1).max(80)
/** `lab` (everyone), `members` (owner + members) or `private` (owner). */
const visibility = z.enum(SUBJECT_VISIBILITIES)

export const createSubjectSchema = z.object({
  title,
  body: body.optional(),
  stage: stageRef.optional(),
  tags: tagNames.optional(),
  owner: owner.nullable().optional(),
  /** A lab project, by name or id. Omitted or `null`: none. */
  project: projectRef.nullable().optional(),
  /** Only needed when the subject is filed straight into a completed or dropped stage. */
  conclusion: conclusion.optional(),
  /** Omitted: `lab`. A `private` or `members` subject is filed by its owner (the caller). */
  visibility: visibility.optional(),
  /** Who a `members` subject is shared with: `me`, a user id, an email or a display name each. */
  members: z.array(owner).max(50).optional(),
})

/** No defaults here: a PATCH must never rewrite a field its caller did not send. */
export const updateSubjectSchema = z
  .object({
    title,
    body: body.nullable(),
    stage: stageRef,
    conclusion: conclusion.nullable(),
    tags: tagNames,
    owner: owner.nullable(),
    /** A lab project, by name or id; `null` takes the subject out of its project. */
    project: projectRef.nullable(),
    position: z.number().int().min(-1_000_000).max(1_000_000),
    archived: z.boolean(),
    /** Owner only. `lab` publishes, one-way; `lab →` anything else is refused (`already_published`). */
    visibility,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.')

/** `POST /subjects/{ref}/members`: who to share the subject with. */
export const subjectMemberSchema = z.object({
  /** `me`, a user id, an email or a display name. */
  user: owner,
})

export const createSubjectNoteSchema = z.object({
  note: z.string().trim().min(1).max(100_000),
  kind: z.enum(WRITABLE_NOTE_KINDS).default('note'),
})

/** A person's note on a subject (075). Markdown; the same ceiling as a log note. */
export const subjectHumanNoteSchema = z.object({
  body: z.string().trim().min(1).max(100_000),
})

export const createSubjectTodoSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100_000).optional(),
  priority: taskPriority.default('medium'),
  type: taskType.default('chore'),
  /** A todo is on the list to do, so it starts at `todo` rather than the backlog. */
  status: taskStatus.default('todo'),
  /** Whose it is. Omitted, the caller's human. */
  assignee: owner.optional(),
})

export const listSubjectsQuery = z.object({
  stage: z.string().trim().min(1).max(80).optional(),
  /** One tag, or a comma list: subjects carrying any of them. */
  tag: z.string().trim().min(1).max(400).optional(),
  owner: z.string().trim().min(1).max(320).optional(),
  /** A lab project name or id, `none` for subjects in no project, or a comma list: subjects in any of them. */
  project: z.string().trim().min(1).max(400).optional(),
  q: z.string().trim().min(1).max(500).optional(),
  /**
   * `include`: live and archived. `only` (or `true`/`1`): archived only.
   * Omitted, `false` or `0`: live only.
   */
  archived: z
    .enum(['include', 'only', 'true', 'false', '1', '0'])
    .optional()
    .transform((v): ArchivedFilter | undefined =>
      v === undefined ? undefined : v === 'include' ? 'include' : v === 'only' || v === 'true' || v === '1' ? 'only' : 'exclude',
    ),
})

/**
 * Filters on a todo list: the subject it belongs to (`S-12`), and the lab
 * project that subject is in (name or id, `none`, or a comma list).
 */
export const labTodoFilterQuery = z.object({
  subject: z.string().trim().min(1).max(80).optional(),
  project: z.string().trim().min(1).max(400).optional(),
})

export type ArchivedFilter = 'exclude' | 'include' | 'only'

export const createStageSchema = z.object({
  name: z.string().trim().min(1).max(40),
  category: z.enum(STAGE_CATEGORIES),
  color: colour.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
})

export const updateStageSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    category: z.enum(STAGE_CATEGORIES),
    color: colour,
    position: z.number().int().min(0).max(10_000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.')

export const reorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
})

const tagName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform((v) => v.toLowerCase())

export const createTagSchema = z.object({
  name: tagName,
  color: colour.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
})

export const updateTagSchema = z
  .object({ name: tagName, color: colour, position: z.number().int().min(0).max(10_000) })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.')

const labProjectName = z.string().trim().min(1).max(40)

/** A tracker's name as data: `linear`, `github`. Lower-cased; an empty string reads as none. */
export const HANDOFF_TRACKER = /^[a-z][a-z0-9-]{1,31}$/
const handoffTrackerName = z
  .string()
  .trim()
  .transform((v) => v.toLowerCase())
  .pipe(z.string().regex(/^(?:[a-z][a-z0-9-]{1,31})?$/, 'expected a tracker name like linear or github (2-32 characters, a letter first)'))
  .transform((v) => v || null)

/** A place in the tracker: a project key, an `owner/repo`. An empty string reads as none. */
export const HANDOFF_TARGET = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const handoffTargetName = z
  .string()
  .trim()
  .pipe(z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._/-]{0,99})?$/, 'expected a target like PROJ or owner/repo (1-100 characters)'))
  .transform((v) => v || null)

type HandoffFields = { handoffTracker?: string | null; handoffTarget?: string | null }

/** Tracker and target travel together: both, or neither (null clears). */
const handoffPair = (value: HandoffFields, ctx: z.RefinementCtx) => {
  const touched = value.handoffTracker !== undefined || value.handoffTarget !== undefined
  if (touched && (value.handoffTracker == null) !== (value.handoffTarget == null)) {
    ctx.addIssue({
      code: 'custom',
      path: [value.handoffTracker == null ? 'handoffTracker' : 'handoffTarget'],
      message: 'A hand-off needs both a tracker and a target, or neither (null clears it).',
    })
  }
}

export const createLabProjectSchema = z
  .object({
    name: labProjectName,
    color: colour.optional(),
    /** Where `croft handoff` sends this project's todos: the tracker, and a target in it. */
    handoffTracker: handoffTrackerName.nullable().optional(),
    handoffTarget: handoffTargetName.nullable().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
  })
  .superRefine(handoffPair)

export const updateLabProjectSchema = z
  .object({
    name: labProjectName,
    color: colour,
    /** Both `null` clears the hand-off. */
    handoffTracker: handoffTrackerName.nullable(),
    handoffTarget: handoffTargetName.nullable(),
    position: z.number().int().min(0).max(10_000),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.')
  .superRefine(handoffPair)

/**
 * What a lab project body says about the hand-off: `undefined` leaves it,
 * `null` clears it, a pair sets it.
 */
export const handoffOfProjectBody = (
  body: HandoffFields,
): undefined | null | { tracker: string; target: string } => {
  if (body.handoffTracker === undefined && body.handoffTarget === undefined) return undefined
  if (!body.handoffTracker || !body.handoffTarget) return null
  return { tracker: body.handoffTracker, target: body.handoffTarget }
}

/** Not whitespace or a control character anywhere: a ref is one token. */
const NO_SPACE_OR_CONTROL = /^[^\s\u0000-\u001f\u007f]+$/

export const handoffSchema = z.object({
  tracker: handoffTrackerName.refine((v) => v !== null, 'A tracker name is required.'),
  /** The task's ref in that tracker: 1-200 characters, no whitespace or control characters. */
  ref: z.string().trim().min(1).max(200).regex(NO_SPACE_OR_CONTROL, 'A ref has no whitespace or control characters.'),
  /** Where to open it. http(s) only. */
  url: z.string().trim().max(2000).regex(/^https?:\/\//i, 'expected an http(s) URL').nullable().optional(),
  status: z.string().trim().min(1).max(40).optional(),
  /** With a done or cancelled status: the tracker's resolution, for the subject's log and the todo's close. */
  resolution: z.string().trim().max(20_000).optional(),
  /** The tracker's resolution kind. One Croft does not have closes the todo as `verified`. */
  resolutionKind: z.string().trim().min(1).max(40).optional(),
  /**
   * Hand off a todo whose subject is private or members-only anyway. Without it
   * that is refused with `subject_not_published`: the tracker has no notion of
   * who may see what.
   */
  force: z.boolean().optional(),
})

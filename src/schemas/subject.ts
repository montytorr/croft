import { z } from 'zod'
import { STAGE_CATEGORIES, SUBJECT_NOTE_KINDS } from '@/lib/lab/types'
import { taskPriority, taskStatus, taskType } from './task'

/**
 * Kinds a caller may write. `stage` is the server's own: it is written on
 * every stage change, and one posted by hand would put a move in the history
 * that never happened.
 */
export const WRITABLE_NOTE_KINDS = SUBJECT_NOTE_KINDS.filter(
  (kind): kind is Exclude<(typeof SUBJECT_NOTE_KINDS)[number], 'stage'> => kind !== 'stage',
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

export const createSubjectSchema = z.object({
  title,
  body: body.optional(),
  stage: stageRef.optional(),
  tags: tagNames.optional(),
  owner: owner.nullable().optional(),
  /** Only needed when the subject is filed straight into a completed or dropped stage. */
  conclusion: conclusion.optional(),
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
    position: z.number().int().min(-1_000_000).max(1_000_000),
    archived: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change.')

export const createSubjectNoteSchema = z.object({
  note: z.string().trim().min(1).max(100_000),
  kind: z.enum(WRITABLE_NOTE_KINDS).default('note'),
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
  tag: z.string().trim().min(1).max(40).optional(),
  owner: z.string().trim().min(1).max(320).optional(),
  q: z.string().trim().min(1).max(500).optional(),
  archived: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
})

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

export const cairnConnectionSchema = z.object({
  /** Where the Cairn instance is served. `null` disconnects. */
  url: z
    .string()
    .trim()
    .url()
    .regex(/^https?:\/\//, 'Use an http(s) URL.')
    .transform((v) => v.replace(/\/+$/, ''))
    .nullable(),
  /** Omitted keeps the stored key; `null` clears it. */
  apiKey: z.string().trim().min(8).max(500).nullable().optional(),
})

/** Cairn's own ref shape: a key of two to ten characters. */
export const CAIRN_REF = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/

export const cairnLinkSchema = z.object({
  cairnRef: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(CAIRN_REF, 'expected a Cairn task ref like CAIRN-331')),
  cairnStatus: z.string().trim().min(1).max(40).optional(),
})

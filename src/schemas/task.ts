import { z } from 'zod'

/**
 * Single source of truth for Croft's domain vocabulary.
 *
 * The API, the CLI, the OpenAPI spec and the UI all import from here, so a new
 * task type is added in exactly one place — plus a one-line migration to widen
 * the matching CHECK constraint.
 */

export const TASK_TYPES = ['feature', 'bug', 'improvement', 'chore', 'spike', 'docs'] as const

/** Board order. The UI renders columns in this sequence. */
export const TASK_STATUSES = [
  'backlog',
  'todo',
  'doing',
  'in-review',
  'done',
  'cancelled',
] as const

/** Statuses that require a resolution before the API will accept the transition. */
export const TERMINAL_STATUSES = ['done', 'cancelled'] as const

export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const

export const RESOLUTION_KINDS = [
  'fixed',
  /**
   * The fix was already there; this close is the record that somebody checked.
   *
   * Six tasks in one triage were closed after reading the current code and
   * finding the defect already gone. `fixed` was the only kind that fit and it
   * claims authorship of somebody else's commit — and makes the close
   * indistinguishable from one where nobody read anything.
   */
  'verified',
  'wont-fix',
  'duplicate',
  'not-reproducible',
  'superseded',
  'answered',
] as const

export const NOTE_KINDS = ['note', 'finding', 'decision', 'attempt', 'handoff'] as const

export const ACTOR_TYPES = ['human', 'agent'] as const

export const taskType = z.enum(TASK_TYPES)
export const taskStatus = z.enum(TASK_STATUSES)
export const taskPriority = z.enum(TASK_PRIORITIES)
export const resolutionKind = z.enum(RESOLUTION_KINDS)
export const noteKind = z.enum(NOTE_KINDS)

export type TaskType = z.infer<typeof taskType>
export type TaskStatus = z.infer<typeof taskStatus>
export type TaskPriority = z.infer<typeof taskPriority>
export type ResolutionKind = z.infer<typeof resolutionKind>
export type NoteKind = z.infer<typeof noteKind>

export const isTerminal = (s: TaskStatus): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(s)

const assigneeField = z.string().trim().min(1).max(320)

/**
 * Field definitions WITHOUT defaults.
 *
 * This split is load-bearing. `.default()` survives `.partial()` — Zod's
 * ZodOptional wraps the ZodDefault rather than replacing it, so
 * `createTaskSchema.partial().parse({})` yields `{ type: 'feature' }`. Deriving
 * the PATCH schema that way made every update silently reset `type` and
 * `priority` to their defaults, quietly corrupting rows the caller never
 * mentioned. Defaults belong on the create schema only.
 */
const taskFields = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(100_000),
  type: taskType,
  status: taskStatus,
  priority: taskPriority,
  labels: z.array(z.string().min(1).max(50)).max(20),
  dueDate: z.string().date(),
})

/**
 * Types whose value is the body. A chore is often fully described by its
 * title; a bug or a spike with no body is not yet a report.
 */
export const NEEDS_BODY: readonly TaskType[] = ['bug', 'spike']

/** Below this a "body" is a restated title, which is what the rule exists to stop. */
export const MIN_BODY_CHARS = 40

export const createTaskSchema = taskFields
  .partial()
  .extend({
    title: z.string().min(1).max(300),
    type: taskType.default('feature'),
    status: taskStatus.default('backlog'),
    priority: taskPriority.default('medium'),
    labels: z.array(z.string().min(1).max(50)).max(20).default([]),
    /** File it under an existing task. A ref (`CAI-42`) or uuid. */
    parentRef: z.string().min(2).max(60).optional(),
    /**
     * The human who owns it: `me`, an email, a display name or a user id.
     * Omitted, it is the caller's human — for an agent, the owner of its key.
     */
    assignee: assigneeField.optional(),
    /**
     * File a bug or spike with no body on purpose — `croft add --force-empty`.
     * The escape hatch has to be something the caller says, never a default.
     */
    forceEmpty: z.boolean().optional(),
  })
  /**
   * The bug/spike body rule, where every caller meets it (CROFT-291).
   *
   * It lived only in the CLI, and there it worked: none filed empty since it
   * shipped, against 71 before. The API accepted an empty description, so the
   * UI, the MCP facade and any direct caller walked straight past it.
   */
  .superRefine((value, ctx) => {
    if (!NEEDS_BODY.includes(value.type) || value.forceEmpty) return
    if ((value.description ?? '').trim().length >= MIN_BODY_CHARS) return
    ctx.addIssue({
      code: 'custom',
      path: ['description'],
      message:
        `A ${value.type} needs a description of at least ${MIN_BODY_CHARS} characters: what happens, ` +
        'what you expected, and how to see it. If the title really is the whole story, send forceEmpty: true ' +
        '(croft add --force-empty).',
    })
  })

/** Partial update. No defaults, so absent fields stay absent. */
/** A field a removed feature used to take: absent is fine, present is refused with `message`. */
const removedField = (message: string) => z.unknown().optional().refine((value) => value === undefined, { message })

export const updateTaskSchema = taskFields.partial().extend({
  resolution: z.string().max(100_000).optional(),
  resolutionKind: resolutionKind.optional(),
  /**
   * The task this one duplicates, as a ref or uuid. Only meaningful alongside
   * `resolutionKind: 'duplicate'`; the database refuses the pair otherwise.
   * `null` clears it.
   */
  duplicateOf: z.string().min(2).max(60).nullable().optional(),
  /** Re-parent, or `null` to lift it back to the top level. */
  parentRef: z.string().min(2).max(60).nullable().optional(),
  /** Reassign: `me`, an email, a display name or a user id. Never cleared. */
  assignee: assigneeField.optional(),
  /** `null` clears it — the one field on `taskFields` that can be unset rather than just left alone. */
  dueDate: z.string().date().nullable().optional(),
  /**
   * Removed in 0.8, refused rather than ignored: a 0.7 CLI's `update --project`
   * would otherwise answer 200 and change nothing.
   */
  project: removedField('Moving a todo between projects was removed in 0.8: Croft has one todo list. Update the CLI (croft setup).'),
  alsoProjects: removedField('Linking a todo to other projects was removed in 0.8. Update the CLI (croft setup).'),
})

export const createNoteSchema = z.object({
  note: z.string().min(1).max(100_000),
  kind: noteKind.default('note'),
  facts: z.array(z.string().min(1).max(500)).max(50).optional(),
})

/** `CAI-42` — the identifier agents actually use in prose. */
export const taskRefSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{0,9}-\d+$/, 'expected a task ref like CAI-42')

export const parseTaskRef = (ref: string): { key: string; number: number } => {
  const parsed = taskRefSchema.parse(ref)
  const idx = parsed.lastIndexOf('-')
  return { key: parsed.slice(0, idx), number: Number(parsed.slice(idx + 1)) }
}

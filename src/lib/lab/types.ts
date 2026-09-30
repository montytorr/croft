export const STAGE_CATEGORIES = ['planned', 'active', 'completed', 'dropped'] as const
export type StageCategory = (typeof STAGE_CATEGORIES)[number]

export const CONCLUDING_CATEGORIES: readonly StageCategory[] = ['completed', 'dropped']
export const isConcluding = (category: StageCategory) => CONCLUDING_CATEGORIES.includes(category)

export const SUBJECT_NOTE_KINDS = ['note', 'finding', 'decision', 'attempt', 'handoff', 'stage'] as const
export type SubjectNoteKind = (typeof SUBJECT_NOTE_KINDS)[number]

export const TODO_PROJECT_KEY = 'T'

export const subjectRef = (number: number) => `S-${number}`

/** Accepts `S-12`, `s-12` or `12`. */
export const parseSubjectRef = (ref: string): number | null => {
  const match = /^(?:[Ss]-)?(\d{1,7})$/.exec(ref.trim())
  return match ? Number(match[1]) : null
}

export type Stage = {
  id: string
  name: string
  color: string
  category: StageCategory
  position: number
}

export type Tag = {
  id: string
  name: string
  color: string
  position: number
}

/**
 * A lab project: a curated grouping of subjects (Trig, Croft, Dispofi…), each
 * optionally mapped to the Cairn project that receives its todos on `croft push`.
 * Not a task container: todos keep their `T-n` refs whatever their subject's project.
 */
export type LabProject = {
  id: string
  name: string
  color: string
  cairn_key: string | null
  position: number
}

export type SubjectOwner = { id: string; name: string } | null

export type SubjectSummary = {
  id: string
  ref: string
  number: number
  title: string
  stage: Stage
  tags: Tag[]
  project: LabProject | null
  owner: SubjectOwner
  conclusion: string | null
  todos: { open: number; done: number }
  position: number
  actor_id: string
  created_at: string
  updated_at: string
  /** Set when the subject was archived: off the board, still searchable. */
  archived_at: string | null
}

export type Subject = SubjectSummary & {
  body: string | null
  concluded_at: string | null
  /** Set when the subject is archived. Optional (UI addition): absent reads as "not archived". */
  archived_at?: string | null
}

export type SubjectNote = {
  id: string
  kind: SubjectNoteKind
  note: string
  actor_type: 'human' | 'agent'
  actor_id: string
  created_at: string
}

export type SubjectTodo = {
  id: string
  ref: string
  number: number
  title: string
  status: string
  claimed_by: string | null
  cairn_ref: string | null
  cairn_status: string | null
  updated_at: string
}

export type CairnConnection = {
  url: string | null
  key_set: boolean
  last_synced_at: string | null
}

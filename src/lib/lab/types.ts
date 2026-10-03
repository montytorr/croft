export const STAGE_CATEGORIES = ['planned', 'active', 'completed', 'dropped'] as const
export type StageCategory = (typeof STAGE_CATEGORIES)[number]

export const CONCLUDING_CATEGORIES: readonly StageCategory[] = ['completed', 'dropped']
export const isConcluding = (category: StageCategory) => CONCLUDING_CATEGORIES.includes(category)

/** `stage` and `visibility` are written by the server only: a move, a publish, a share. */
export const SUBJECT_NOTE_KINDS = ['note', 'finding', 'decision', 'attempt', 'handoff', 'stage', 'visibility'] as const
export type SubjectNoteKind = (typeof SUBJECT_NOTE_KINDS)[number]

/**
 * Who can see a subject and its todos (v0.4). `lab`: everyone, the default.
 * `members`: its owner and the people it is shared with. `private`: its owner.
 * Publishing to the lab is one-way.
 */
export const SUBJECT_VISIBILITIES = ['private', 'members', 'lab'] as const
export type SubjectVisibility = (typeof SUBJECT_VISIBILITIES)[number]

export type SubjectMember = { id: string; name: string }

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
  visibility: SubjectVisibility
  /**
   * Who the subject is shared with (the owner is not listed). Only a
   * `members` subject lets them see it; a `private` one keeps the list, so
   * sharing it again restores it. Empty for a `lab` subject.
   */
  members: SubjectMember[]
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

/**
 * A person's note on a subject: free markdown, editable and removable by its
 * author. Separate from the write-up (one shared document) and from the log
 * (append-only, what was found and tried, mostly written by agents).
 */
export type SubjectHumanNote = {
  id: string
  body: string
  author: { id: string; name: string }
  created_at: string
  updated_at: string
}

/** A file on a subject or a todo. URLs are signed and expire within the hour. */
export type Attachment = {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  preview_url: string
  download_url: string
  /** Stable, session-authenticated URL (redirects to a fresh signed preview): what markdown embeds. */
  content_url: string
  /** image = shown inline; html = sandboxed iframe only; other = download. */
  kind: 'image' | 'html' | 'pdf' | 'video' | 'other'
  uploaded_by: string
  created_at: string
}

/** A todo row as the lab shows it: the task plus the subject it belongs to. */
export type LabTodo = SubjectTodo & {
  priority: string
  assignee: { id: string; name: string } | null
  subject: {
    ref: string
    number: number
    title: string
    project: { name: string; color: string } | null
    /** A lock on /todos and /board for a subject that is not `lab`. Always sent; optional for fixtures. */
    visibility?: SubjectVisibility
  } | null
}

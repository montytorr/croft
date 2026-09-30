import * as labAdmin from '@/lib/api/lab-admin'
import * as subjects from '@/lib/api/subjects'
import * as cairn from '@/lib/api/cairn-link'
import * as humanNotes from '@/lib/api/human-notes'
import * as subjectFiles from '@/lib/api/subject-attachments'
import * as labTodos from '@/lib/api/lab-todos'
import { isSubjectVisible, type Viewer } from '@/lib/api/visibility'
import type {
  Attachment,
  CairnConnection,
  LabProject,
  LabTodo,
  Stage,
  Subject,
  SubjectHumanNote,
  SubjectNote,
  SubjectSummary,
  SubjectTodo,
  Tag,
} from './types'

/**
 * Server-side reads for pages. The same functions the API routes use, so a
 * page and `croft subject list` can never disagree about what is on the board.
 * Server components only: these reach the database directly.
 *
 * Every read of subject or todo data takes the `viewer` (v0.4): a subject the
 * viewer may not see is null, and its notes, todos and files are empty — the
 * same answer as for one that does not exist. Pages call `notFound()` on it.
 */

/** Guards the by-id reads below: a page only asks after `getSubject`, but the check costs one query. */
const whenVisible = async <T>(subjectId: string, viewer: Viewer, read: () => Promise<T[]>): Promise<T[]> =>
  (await isSubjectVisible(subjectId, viewer.id)) ? read() : []

export const listStages = (): Promise<Stage[]> => labAdmin.listStages()

export const listTags = (): Promise<Tag[]> => labAdmin.listTags()

/** In order. Each row also carries `subjects`: how many the viewer can see (archived ones included) are in it. */
export const listLabProjects = (viewer: Viewer): Promise<(LabProject & { subjects: number })[]> =>
  labAdmin.listLabProjects(viewer.id)

export const listSubjects = (filters: {
  stage?: string
  tag?: string
  ownerId?: string
  /** Lab project name or id, `none`, or a comma list of them: subjects in any. */
  project?: string
  q?: string
  /** `true` or `'only'`: archived only. `'include'`: live and archived. Omitted: live only. */
  archived?: boolean | 'exclude' | 'include' | 'only'
} | undefined, viewer: Viewer): Promise<SubjectSummary[]> => subjects.listSubjects(filters ?? {}, viewer.id)

/** Null for a subject that does not exist or that the viewer may not see. */
export const getSubject = (number: number, viewer: Viewer): Promise<Subject | null> =>
  subjects.getSubjectByNumber(number, viewer.id)

/** Newest first. */
export const listSubjectNotes = (subjectId: string, viewer: Viewer): Promise<SubjectNote[]> =>
  whenVisible(subjectId, viewer, () => subjects.listSubjectNotes(subjectId))

/** Open todos first. */
export const listSubjectTodos = (subjectId: string, viewer: Viewer): Promise<SubjectTodo[]> =>
  whenVisible(subjectId, viewer, () => subjects.listSubjectTodos(subjectId))

/** People's notes on the subject, newest first. */
export const listSubjectHumanNotes = (subjectId: string, viewer: Viewer): Promise<SubjectHumanNote[]> =>
  whenVisible(subjectId, viewer, () => humanNotes.listSubjectHumanNotes(subjectId))

/** The subject's files, oldest first, with fresh signed links (1h) and a stable `content_url`. */
export const listSubjectAttachments = (subjectId: string, viewer: Viewer): Promise<Attachment[]> =>
  whenVisible(subjectId, viewer, () => subjectFiles.listSubjectAttachments(subjectId))

/**
 * Every todo (project T) with its subject and that subject's lab project.
 * Open ones first unless `includeClosed`. `subject`: `S-12` or an id;
 * `project`: a lab project name or id, `none`, or a comma list. An unknown
 * subject or project gives an empty list.
 */
export const listLabTodos = (filters: labTodos.ListLabTodosOptions | undefined, viewer: Viewer): Promise<LabTodo[]> =>
  labTodos.listLabTodos(filters ?? {}, viewer.id)

/** Whether Cairn is connected. Never the key. Gate the page on the viewer being an admin. */
export const getCairnConnection = (): Promise<CairnConnection> => cairn.getCairnConnection()

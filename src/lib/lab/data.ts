import * as labAdmin from '@/lib/api/lab-admin'
import * as subjects from '@/lib/api/subjects'
import * as cairn from '@/lib/api/cairn-link'
import type { CairnConnection, LabProject, Stage, Subject, SubjectNote, SubjectSummary, SubjectTodo, Tag } from './types'

/**
 * Server-side reads for pages. The same functions the API routes use, so a
 * page and `croft subject list` can never disagree about what is on the board.
 * Server components only: these reach the database directly.
 */

export const listStages = (): Promise<Stage[]> => labAdmin.listStages()

export const listTags = (): Promise<Tag[]> => labAdmin.listTags()

/** In order. Each row also carries `subjects`: how many (archived ones included) are in it. */
export const listLabProjects = (): Promise<(LabProject & { subjects: number })[]> => labAdmin.listLabProjects()

export const listSubjects = (filters?: {
  stage?: string
  tag?: string
  ownerId?: string
  /** Lab project name or id, `none`, or a comma list of them: subjects in any. */
  project?: string
  q?: string
  /** `true` or `'only'`: archived only. `'include'`: live and archived. Omitted: live only. */
  archived?: boolean | 'exclude' | 'include' | 'only'
}): Promise<SubjectSummary[]> => subjects.listSubjects(filters ?? {})

export const getSubject = (number: number): Promise<Subject | null> => subjects.getSubjectByNumber(number)

/** Newest first. */
export const listSubjectNotes = (subjectId: string): Promise<SubjectNote[]> => subjects.listSubjectNotes(subjectId)

/** Open todos first. */
export const listSubjectTodos = (subjectId: string): Promise<SubjectTodo[]> => subjects.listSubjectTodos(subjectId)

/** Whether Cairn is connected. Never the key. Gate the page on the viewer being an admin. */
export const getCairnConnection = (): Promise<CairnConnection> => cairn.getCairnConnection()

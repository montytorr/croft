/**
 * The subject page's tabs. A plain module, not the client component, because
 * the server page validates `?tab=` too: a function exported from a 'use
 * client' file cannot be called on the server.
 */
export const SUBJECT_TABS = ['writeup', 'todos', 'notes', 'log', 'files', 'details'] as const
export type SubjectTab = (typeof SUBJECT_TABS)[number]

export const isSubjectTab = (value: string | undefined): value is SubjectTab =>
  (SUBJECT_TABS as readonly string[]).includes(value ?? '')

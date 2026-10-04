/**
 * What `c` creates where you are. On the todo surfaces — the todo board, the
 * list of all todos, a todo's own page (under `/projects/…/tasks/…`) — it is a
 * todo, as it always was; everywhere else in the lab it is a new subject.
 */
export const createsTodo = (pathname: string | null | undefined): boolean =>
  /^\/(projects|board|todos)(\/|$)/.test(pathname ?? '')

export type TodoContext = {
  /** The subject the page is about, when there is one. */
  subject: number | null
  /** The todo whose page it is, when it is one: what a sub-task would hang from. */
  parentRef: string | null
}

/**
 * What the New todo dialog should default to, read from where you are: a
 * subject's page names the subject, a todo's page names a parent (and its
 * subject, which the dialog looks up).
 */
export const todoContext = (pathname: string | null | undefined): TodoContext => {
  const path = pathname ?? ''
  const subject = /^\/subjects\/(\d+)(\/|$)/.exec(path)
  if (subject) return { subject: Number(subject[1]), parentRef: null }
  const todo = /^\/projects\/T\/tasks\/(\d+)(\/|$)/i.exec(path)
  if (todo) return { subject: null, parentRef: `T-${todo[1]}` }
  return { subject: null, parentRef: null }
}

/** True when a keystroke belongs to a field rather than to the page. */
export const typingInField = (): boolean => {
  const el = document.activeElement
  return (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  )
}

/**
 * What `c` creates where you are. On the todo surfaces — the todo board, the
 * list of all todos, a todo's own page (under `/projects/…/tasks/…`) — it is a
 * todo, as it always was; everywhere else in the lab it is a new subject.
 */
export const createsTodo = (pathname: string | null | undefined): boolean =>
  /^\/(projects|board|todos)(\/|$)/.test(pathname ?? '')

/** True when a keystroke belongs to a field rather than to the page. */
export const typingInField = (): boolean => {
  const el = document.activeElement
  return (
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  )
}

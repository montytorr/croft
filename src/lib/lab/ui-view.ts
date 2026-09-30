import { parseProjectView, viewCookieName, type ProjectView } from '@/lib/project-view'

export type LabView = ProjectView

/** The lab's list-or-board choice, remembered like a project's (`croft-view-lab`). */
export const LAB_VIEW_COOKIE = viewCookieName('lab')

export const parseLabView = parseProjectView

/** Per viewer, per browser; Secure wherever the page itself is served over HTTPS. */
export const rememberLabView = (view: LabView) => {
  const secure = window.location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${LAB_VIEW_COOKIE}=${view}; path=/; max-age=31536000; samesite=lax${secure}`
}

export type ProjectView = 'board' | 'list'

export const viewCookieName = (projectKey: string) => `croft-view-${projectKey}`

export const parseProjectView = (value: string | undefined): ProjectView | null =>
  value === 'board' || value === 'list' ? value : null

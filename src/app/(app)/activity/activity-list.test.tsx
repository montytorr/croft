import { describe, expect, it } from 'vitest'
import type { ActivityRow } from '@/lib/api/activity-feed'
import { hrefFor, titleFor } from './activity-list'

const row = (overrides: Partial<ActivityRow>): ActivityRow => ({
  kind: 'event',
  at: '2026-09-22T08:00:00.000Z',
  actor: 'claude-code',
  project_key: 'HOL',
  ref: 'HOL',
  title: '',
  detail: 'project_key_changed',
  ...overrides,
})

describe('project events in the activity feed', () => {
  it('link a project-level event to the todos, projects having no page', () => {
    expect(hrefFor(row({}))).toBe('/todos')
  })

  it('still link a task event to the task', () => {
    expect(hrefFor(row({ ref: 'HOL-113', detail: 'status_changed' }))).toBe('/projects/HOL/tasks/113')
  })

  it('say something when the feed sent no title', () => {
    expect(titleFor(row({}))).toBe('Project key changed — now HOL')
    expect(titleFor(row({ detail: 'project_renamed' }))).toBe('Project HOL renamed')
  })

  it('prefer the title the feed supplies', () => {
    expect(titleFor(row({ title: 'AC → HOL' }))).toBe('AC → HOL')
  })
})

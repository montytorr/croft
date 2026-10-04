import { describe, expect, it } from 'vitest'
import { refuseArchived, TASK_FIELDS, TASK_LIST_FIELDS, type TaskRow } from './tasks'

describe('refuseArchived', () => {
  const task = (project: Record<string, unknown> | Record<string, unknown>[]): TaskRow => ({
    id: 't1',
    number: 42,
    project,
  })

  it('refuses a task whose home project is archived', async () => {
    const response = refuseArchived(task({ key: 'AC', status: 'archived' }))
    expect(response).not.toBeNull()
    expect(response!.status).toBe(409)
    const body = await response!.json()
    expect(body.success).toBe(false)
    expect(body.code).toBe('conflict')
    expect(body.error).toContain('AC-42')
    expect(body.error).toContain('archived')
    expect(body.project).toBe('AC')
  })

  it('allows a task in an active project', () => {
    expect(refuseArchived(task({ key: 'AC', status: 'active' }))).toBeNull()
  })

  it('reads the embed whether it is aliased `project` or plain `projects`', () => {
    const viaPlural: TaskRow = { id: 't1', number: 1, projects: { key: 'AC', status: 'archived' } }
    expect(refuseArchived(viaPlural)).not.toBeNull()
  })

  it('reads an array-shaped embed (the adapter shape for a to-one join)', () => {
    expect(refuseArchived(task([{ key: 'AC', status: 'archived' }]))).not.toBeNull()
  })

  it('does nothing when the task carries no project embed at all', () => {
    expect(refuseArchived({ id: 't1', number: 1 })).toBeNull()
  })
})

/** Key-based task refs require the embedded project relation. */
describe('task field lists', () => {
  it.each([
    ['TASK_FIELDS', TASK_FIELDS],
    ['TASK_LIST_FIELDS', TASK_LIST_FIELDS],
  ])('%s embeds projects with an inner join', (_name, fields) => {
    expect(fields).toContain('projects!project_id!inner')
  })

  it.each([
    ['TASK_FIELDS', TASK_FIELDS],
    ['TASK_LIST_FIELDS', TASK_LIST_FIELDS],
  ])('%s does not encode the legacy owner scope', (_name, fields) => {
    expect(fields).not.toContain('owner_user_id')
  })

  // Columns added by later migrations that the API reads back.
  it.each(['duplicate_of', 'parent_id', 'resolution', 'resolution_kind'])(
    'TASK_FIELDS selects %s',
    (column) => {
      expect(TASK_FIELDS).toContain(column)
    },
  )
})

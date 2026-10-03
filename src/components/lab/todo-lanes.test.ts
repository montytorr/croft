import { describe, expect, it } from 'vitest'
import { boardLanes, counts, listGroups, needsResolution } from './todo-lanes'

const todo = (status: string) => ({ status })

describe('boardLanes', () => {
  it('shows the four working lanes even when empty', () => {
    expect(boardLanes([], false)).toEqual(['todo', 'doing', 'in-review', 'done'])
  })

  it('adds backlog only when something is in it, in board order', () => {
    expect(boardLanes([todo('backlog')], false)).toEqual(['backlog', 'todo', 'doing', 'in-review', 'done'])
  })

  it('keeps cancelled behind the toggle', () => {
    expect(boardLanes([todo('cancelled')], false)).not.toContain('cancelled')
    expect(boardLanes([], true).at(-1)).toBe('cancelled')
  })
})

describe('listGroups', () => {
  it('puts work in hand first and drops empty groups', () => {
    const groups = listGroups([todo('todo'), todo('doing'), todo('done'), todo('doing')], false)
    expect(groups.map((g) => [g.status, g.todos.length])).toEqual([
      ['doing', 2],
      ['todo', 1],
      ['done', 1],
    ])
  })

  it('hides cancelled unless asked', () => {
    expect(listGroups([todo('cancelled')], false)).toEqual([])
    expect(listGroups([todo('cancelled')], true)).toHaveLength(1)
  })

  it('reads an unknown status as todo rather than losing the row', () => {
    expect(listGroups([todo('weird')], false)[0]?.status).toBe('todo')
  })
})

describe('needsResolution', () => {
  it('asks when an open todo is closed', () => {
    expect(needsResolution('doing', 'done')).toBe(true)
    expect(needsResolution('todo', 'cancelled')).toBe(true)
  })

  it('does not ask between the two closed lanes, or when reopening', () => {
    expect(needsResolution('done', 'cancelled')).toBe(false)
    expect(needsResolution('done', 'todo')).toBe(false)
    expect(needsResolution('todo', 'doing')).toBe(false)
  })
})

describe('counts', () => {
  it('splits open, done and cancelled', () => {
    expect(counts([todo('todo'), todo('doing'), todo('done'), todo('cancelled')])).toEqual({ open: 2, done: 1, cancelled: 1 })
  })
})

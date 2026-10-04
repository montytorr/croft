import { describe, expect, it } from 'vitest'
import { createsTodo, todoContext } from './ui-shortcuts'

describe('what c creates', () => {
  it('is a todo on the todo surfaces', () => {
    for (const path of ['/todos', '/board', '/projects/T', '/projects/T/tasks/4']) {
      expect(createsTodo(path), path).toBe(true)
    }
  })

  it('is a subject everywhere else in the lab', () => {
    for (const path of ['/', '/subjects/12', '/search', '/activity', '/settings', '/boards-of-directors', null]) {
      expect(createsTodo(path), String(path)).toBe(false)
    }
  })
})

describe('what the new todo dialog defaults to', () => {
  it('is the subject on a subject page', () => {
    expect(todoContext('/subjects/12')).toEqual({ subject: 12, parentRef: null })
    expect(todoContext('/subjects/12/files')).toEqual({ subject: 12, parentRef: null })
  })

  it('offers the todo as parent on a todo page', () => {
    expect(todoContext('/projects/T/tasks/4')).toEqual({ subject: null, parentRef: 'T-4' })
    expect(todoContext('/projects/t/tasks/4')).toEqual({ subject: null, parentRef: 'T-4' })
  })

  it('has no default elsewhere', () => {
    for (const path of ['/', '/todos', '/board', '/projects/OTHER/tasks/4', '/subjects/abc', null]) {
      expect(todoContext(path), String(path)).toEqual({ subject: null, parentRef: null })
    }
  })
})

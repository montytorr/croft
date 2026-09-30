import { describe, expect, it } from 'vitest'
import { createsTodo } from './ui-shortcuts'

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

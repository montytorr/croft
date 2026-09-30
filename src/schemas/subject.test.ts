import { describe, expect, it } from 'vitest'
import {
  cairnConnectionSchema,
  cairnLinkSchema,
  createStageSchema,
  createSubjectNoteSchema,
  createSubjectSchema,
  createSubjectTodoSchema,
  createTagSchema,
  listSubjectsQuery,
  updateSubjectSchema,
} from './subject'

describe('subject schemas', () => {
  it('needs only a title to file a subject', () => {
    expect(createSubjectSchema.parse({ title: '  Try pgvector ' })).toEqual({ title: 'Try pgvector' })
    expect(createSubjectSchema.safeParse({ title: '' }).success).toBe(false)
  })

  it('lets owner be null to file an unowned subject', () => {
    expect(createSubjectSchema.parse({ title: 'x', owner: null }).owner).toBeNull()
  })

  it('never invents fields on a PATCH', () => {
    expect(updateSubjectSchema.parse({ title: 'New' })).toEqual({ title: 'New' })
    expect(updateSubjectSchema.safeParse({}).success).toBe(false)
  })

  it('accepts a null conclusion and body on PATCH (clearing them)', () => {
    expect(updateSubjectSchema.parse({ conclusion: null, body: null })).toEqual({ conclusion: null, body: null })
  })

  it('refuses stage notes from callers — the server writes those', () => {
    expect(createSubjectNoteSchema.safeParse({ note: 'x', kind: 'stage' }).success).toBe(false)
    expect(createSubjectNoteSchema.parse({ note: 'x' }).kind).toBe('note')
    expect(createSubjectNoteSchema.parse({ note: 'x', kind: 'finding' }).kind).toBe('finding')
  })

  it('defaults a todo to an open chore', () => {
    expect(createSubjectTodoSchema.parse({ title: 'Read the docs' })).toMatchObject({
      status: 'todo',
      type: 'chore',
      priority: 'medium',
    })
  })

  it('reads archived from the query string', () => {
    expect(listSubjectsQuery.parse({ archived: 'true' }).archived).toBe(true)
    expect(listSubjectsQuery.parse({ archived: '0' }).archived).toBe(false)
    expect(listSubjectsQuery.parse({}).archived).toBeUndefined()
  })
})

describe('stage and tag schemas', () => {
  it('only accepts the four categories', () => {
    expect(createStageSchema.safeParse({ name: 'x', category: 'planned' }).success).toBe(true)
    expect(createStageSchema.safeParse({ name: 'x', category: 'someday' }).success).toBe(false)
  })

  it('normalises colours and tag names to lower case', () => {
    expect(createStageSchema.parse({ name: 'x', category: 'active', color: '#AABBCC' }).color).toBe('#aabbcc')
    expect(createTagSchema.parse({ name: '  AI ' }).name).toBe('ai')
    expect(createTagSchema.safeParse({ name: 'x', color: 'red' }).success).toBe(false)
  })
})

describe('cairn schemas', () => {
  it('upper-cases and checks a Cairn ref', () => {
    expect(cairnLinkSchema.parse({ cairnRef: 'cairn-331' }).cairnRef).toBe('CAIRN-331')
    // Croft's own single-letter refs are not Cairn refs.
    expect(cairnLinkSchema.safeParse({ cairnRef: 'T-41' }).success).toBe(false)
  })

  it('trims a trailing slash from the URL and keeps the key optional', () => {
    expect(cairnConnectionSchema.parse({ url: 'https://cairn.example/' })).toEqual({ url: 'https://cairn.example' })
    expect(cairnConnectionSchema.parse({ url: null, apiKey: null })).toEqual({ url: null, apiKey: null })
    expect(cairnConnectionSchema.safeParse({ url: 'ftp://x' }).success).toBe(false)
  })
})

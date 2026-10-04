import { describe, expect, it } from 'vitest'
import {
  handoffOfProjectBody,
  handoffSchema,
  createStageSchema,
  createSubjectNoteSchema,
  createSubjectSchema,
  createSubjectTodoSchema,
  createLabProjectSchema,
  createTagSchema,
  listSubjectsQuery,
  updateLabProjectSchema,
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

  it('reads archived from the query string: include, only, or live by default', () => {
    expect(listSubjectsQuery.parse({ archived: 'include' }).archived).toBe('include')
    expect(listSubjectsQuery.parse({ archived: 'only' }).archived).toBe('only')
    // `true`/`1` keep their old meaning: archived only.
    expect(listSubjectsQuery.parse({ archived: 'true' }).archived).toBe('only')
    expect(listSubjectsQuery.parse({ archived: '1' }).archived).toBe('only')
    expect(listSubjectsQuery.parse({ archived: '0' }).archived).toBe('exclude')
    expect(listSubjectsQuery.parse({}).archived).toBeUndefined()
    expect(listSubjectsQuery.safeParse({ archived: 'all' }).success).toBe(false)
  })

  it('takes a comma list of tags', () => {
    expect(listSubjectsQuery.parse({ tag: 'db,search' }).tag).toBe('db,search')
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

describe('lab project schemas', () => {
  it('takes a name and an optional colour', () => {
    expect(createLabProjectSchema.parse({ name: ' Trig ' })).toEqual({ name: 'Trig' })
    expect(createLabProjectSchema.parse({ name: 'Croft', color: '#AABBCC' })).toEqual({ name: 'Croft', color: '#aabbcc' })
    expect(createLabProjectSchema.safeParse({ name: '' }).success).toBe(false)
    expect(createLabProjectSchema.safeParse({ name: 'x'.repeat(41) }).success).toBe(false)
  })

  it('clears the hand-off with null, and never invents fields on a PATCH', () => {
    expect(updateLabProjectSchema.parse({ handoffTracker: null, handoffTarget: null })).toEqual({ handoffTracker: null, handoffTarget: null })
    expect(updateLabProjectSchema.parse({ name: 'Trig' })).toEqual({ name: 'Trig' })
    expect(updateLabProjectSchema.safeParse({}).success).toBe(false)
  })

  it('lets a subject name its project, or leave it with null', () => {
    expect(createSubjectSchema.parse({ title: 'x', project: ' Trig ' }).project).toBe('Trig')
    expect(updateSubjectSchema.parse({ project: null })).toEqual({ project: null })
    expect(listSubjectsQuery.parse({ project: 'Trig,none' }).project).toBe('Trig,none')
  })
})

describe('hand-off schemas', () => {
  it('takes a tracker and a ref, the tracker lower-cased', () => {
    expect(handoffSchema.parse({ tracker: ' GitHub ', ref: ' owner/repo#4 ' })).toEqual({ tracker: 'github', ref: 'owner/repo#4' })
  })

  it('refuses a bad tracker, a ref with whitespace or control characters, and a non-http url', () => {
    for (const tracker of ['', 'a', '1x', 'has space', 'x'.repeat(33)]) {
      expect(handoffSchema.safeParse({ tracker, ref: 'X-1' }).success, tracker).toBe(false)
    }
    for (const ref of ['', 'a b', 'a\tb', 'a\u0000b', 'x'.repeat(201)]) {
      expect(handoffSchema.safeParse({ tracker: 'linear', ref }).success, ref).toBe(false)
    }
    expect(handoffSchema.safeParse({ tracker: 'linear', ref: 'X-1', url: 'ftp://x' }).success).toBe(false)
    expect(handoffSchema.safeParse({ tracker: 'linear', ref: 'X-1', url: `https://x/${'a'.repeat(2000)}` }).success).toBe(false)
    expect(handoffSchema.parse({ tracker: 'linear', ref: 'X-1', url: 'https://x/1', status: 'done', force: true }).url).toBe('https://x/1')
  })

  it('reads a lab project hand-off as a pair, or null to clear it', () => {
    expect(handoffOfProjectBody(createLabProjectSchema.parse({ name: 'x', handoffTracker: 'GitHub', handoffTarget: 'owner/repo' }))).toEqual({
      tracker: 'github',
      target: 'owner/repo',
    })
    expect(handoffOfProjectBody(updateLabProjectSchema.parse({ handoffTracker: null, handoffTarget: null }))).toBeNull()
    expect(handoffOfProjectBody(updateLabProjectSchema.parse({ handoffTracker: '', handoffTarget: '' }))).toBeNull()
    expect(handoffOfProjectBody(updateLabProjectSchema.parse({ name: 'x' }))).toBeUndefined()
  })

  it('wants both halves or neither', () => {
    expect(createLabProjectSchema.safeParse({ name: 'x', handoffTracker: 'linear' }).success).toBe(false)
    expect(updateLabProjectSchema.safeParse({ handoffTarget: 'PROJ' }).success).toBe(false)
    expect(updateLabProjectSchema.safeParse({ handoffTracker: 'linear', handoffTarget: null }).success).toBe(false)
    for (const target of ['-x', 'a b', 'x'.repeat(101)]) {
      expect(createLabProjectSchema.safeParse({ name: 'x', handoffTracker: 'github', handoffTarget: target }).success, target).toBe(false)
    }
  })
})

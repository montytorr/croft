import { describe, expect, it } from 'vitest'
import {
  cairnLinkSchema,
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
  it('takes a name, an optional colour and an optional Cairn key, upper-cased', () => {
    expect(createLabProjectSchema.parse({ name: ' Trig ', cairnKey: 'trig' })).toEqual({ name: 'Trig', cairnKey: 'TRIG' })
    expect(createLabProjectSchema.parse({ name: 'Croft', color: '#AABBCC' })).toEqual({ name: 'Croft', color: '#aabbcc' })
    expect(createLabProjectSchema.safeParse({ name: '' }).success).toBe(false)
    expect(createLabProjectSchema.safeParse({ name: 'x'.repeat(41) }).success).toBe(false)
  })

  it('refuses a Cairn key that is not one', () => {
    for (const bad of ['T', '1ABC', 'TOO-LONG', 'ABCDEFGHIJK', 'A B']) {
      expect(createLabProjectSchema.safeParse({ name: 'x', cairnKey: bad }).success, bad).toBe(false)
    }
  })

  it('clears the key with null or an empty string, and never invents fields on a PATCH', () => {
    expect(updateLabProjectSchema.parse({ cairnKey: null })).toEqual({ cairnKey: null })
    expect(updateLabProjectSchema.parse({ cairnKey: '  ' })).toEqual({ cairnKey: null })
    expect(updateLabProjectSchema.parse({ name: 'Trig' })).toEqual({ name: 'Trig' })
    expect(updateLabProjectSchema.safeParse({}).success).toBe(false)
  })

  it('lets a subject name its project, or leave it with null', () => {
    expect(createSubjectSchema.parse({ title: 'x', project: ' Trig ' }).project).toBe('Trig')
    expect(updateSubjectSchema.parse({ project: null })).toEqual({ project: null })
    expect(listSubjectsQuery.parse({ project: 'Trig,none' }).project).toBe('Trig,none')
  })
})

describe('cairn schemas', () => {
  it('upper-cases and checks a Cairn ref', () => {
    expect(cairnLinkSchema.parse({ cairnRef: 'cairn-331' }).cairnRef).toBe('CAIRN-331')
    // Croft's own single-letter refs are not Cairn refs.
    expect(cairnLinkSchema.safeParse({ cairnRef: 'T-41' }).success).toBe(false)
  })

  it('carries Cairn\'s resolution and kind with an ended status, both optional', () => {
    expect(
      cairnLinkSchema.parse({ cairnRef: 'CAIRN-331', cairnStatus: 'done', cairnResolution: ' Shipped. ', cairnResolutionKind: 'fixed' }),
    ).toEqual({ cairnRef: 'CAIRN-331', cairnStatus: 'done', cairnResolution: 'Shipped.', cairnResolutionKind: 'fixed' })
    expect(cairnLinkSchema.parse({ cairnRef: 'CAIRN-331' })).toEqual({ cairnRef: 'CAIRN-331' })
  })


})

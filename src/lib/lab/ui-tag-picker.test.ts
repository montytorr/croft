import { describe, expect, it } from 'vitest'
import { filterTags, tagToCreate } from './ui-tag-picker'

const tags = [{ name: 'infra' }, { name: 'llm' }, { name: 'infra-cost' }]

describe('the tag picker filter', () => {
  it('keeps the tags containing the query, any case', () => {
    expect(filterTags(tags, 'INFRA').map((t) => t.name)).toEqual(['infra', 'infra-cost'])
  })

  it('shows every tag for an empty query', () => {
    expect(filterTags(tags, '  ')).toHaveLength(3)
  })
})

describe('what an administrator can create from the picker', () => {
  it('offers a new name, lower-cased as tags are stored', () => {
    expect(tagToCreate(tags, ' Pricing ')).toBe('pricing')
  })

  it('offers nothing for a tag that exists, in any case', () => {
    expect(tagToCreate(tags, 'LLM')).toBeNull()
  })

  it('offers a longer name even when an existing tag contains it', () => {
    expect(tagToCreate(tags, 'infra-costs')).toBe('infra-costs')
  })

  it('offers nothing for an empty query or one over the limit', () => {
    expect(tagToCreate(tags, '')).toBeNull()
    expect(tagToCreate(tags, 'x'.repeat(41))).toBeNull()
  })
})

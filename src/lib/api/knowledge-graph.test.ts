import { describe, expect, it } from 'vitest'
import { referencesIn } from './knowledge-graph'

/**
 * The edges of this graph live in prose, not in a table, so reading them out
 * has to agree exactly with what the renderer linkifies. Anywhere the two
 * disagree the map shows a connection the page does not, or hides one it does
 * — and a map that disagrees with the thing it maps is worse than none.
 */
describe('reading references out of a body', () => {
  it('finds a reference', () => {
    expect(referencesIn('See [[proxy-buffer-defaults]] for the layout.')).toEqual([
      'proxy-buffer-defaults',
    ])
  })

  it('normalises the underscore spelling, like the renderer does', () => {
    // Most references in the store are written this way. Reading them
    // literally would leave the map almost edgeless while the pages show
    // links everywhere.
    expect(referencesIn('Related: [[cache_warmup_race]]')).toEqual(['cache-warmup-race'])
  })

  it('counts a reference once however often it is repeated', () => {
    // An entry that mentions another three times is joined to it once. Left
    // uncounted, the busiest entries would look busier still.
    expect(referencesIn('[[a-slug]] and again [[a-slug]] and [[a_slug]]')).toEqual(['a-slug'])
  })

  it('ignores a reference inside a fenced code block', () => {
    // The renderer never linkifies inside a fence, because the parser hands it
    // a code node rather than text. Reading raw bodies has no such help, so an
    // EXAMPLE in a fence would otherwise become a real edge.
    const body = ['Prose [[real-one]].', '```', 'croft know [[an-example]]', '```'].join('\n')

    expect(referencesIn(body)).toEqual(['real-one'])
  })

  it('ignores single brackets, which are ordinary markdown', () => {
    expect(referencesIn('A [link](https://example.com) and [brackets].')).toEqual([])
  })

  it('returns nothing for a body with no references', () => {
    expect(referencesIn('Just prose, no references at all.')).toEqual([])
  })

  it('handles an empty body', () => {
    expect(referencesIn('')).toEqual([])
  })
})

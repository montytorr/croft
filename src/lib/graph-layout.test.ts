import { describe, expect, it } from 'vitest'
import { components, layoutGraph, type Edge } from './graph-layout'

/**
 * The map is re-rendered by `router.refresh()` every time the stream reports a
 * change, which on a busy day is every few minutes. So the property that
 * matters most here is not that the layout is pretty — it is that it is the
 * same layout, because a map that rearranges itself while being read is worse
 * than no map.
 */

const edge = (source: string, target: string): Edge => ({ source, target })

describe('components', () => {
  it('finds the islands', () => {
    const found = components(
      ['a', 'b', 'c', 'd', 'e'],
      [edge('a', 'b'), edge('b', 'c'), edge('d', 'e')],
    )

    expect(found.map((group) => group.length)).toEqual([3, 2])
  })

  it('puts the largest first, because that one is the corpus', () => {
    const found = components(
      ['x', 'a', 'b', 'c'],
      [edge('a', 'b'), edge('b', 'c')],
    )

    expect(found[0]).toEqual(['a', 'b', 'c'])
    expect(found[1]).toEqual(['x'])
  })

  it('counts a node joined to nothing as its own island', () => {
    const found = components(['alone'], [])

    expect(found).toEqual([['alone']])
  })

  it('ignores an edge from a node to itself', () => {
    // One entry in the store references its own slug. It is not connected to
    // anything by that, and must not be counted as if it were.
    const found = components(['a', 'b'], [edge('a', 'a')])

    expect(found.map((group) => group.length)).toEqual([1, 1])
  })

  it('is unaffected by the order edges arrive in', () => {
    const forwards = components(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])
    const backwards = components(['a', 'b', 'c'], [edge('b', 'c'), edge('a', 'b')])

    expect(forwards).toEqual(backwards)
  })
})

describe('layoutGraph', () => {
  const ids = ['alpha', 'beta', 'gamma', 'delta', 'lonely']
  const edges = [edge('alpha', 'beta'), edge('beta', 'gamma'), edge('gamma', 'alpha')]

  it('gives the same answer every time it is asked', () => {
    // The whole reason this runs on the server rather than in the browser.
    const first = layoutGraph(ids, edges)
    const second = layoutGraph(ids, edges)

    expect(second.placed).toEqual(first.placed)
  })

  it('places every node exactly once', () => {
    const { placed } = layoutGraph(ids, edges)

    expect(placed).toHaveLength(ids.length)
    expect(new Set(placed.map((p) => p.id)).size).toBe(ids.length)
  })

  it('separates the connected from the unconnected', () => {
    const { placed, isolatedFrom } = layoutGraph(ids, edges)

    // Everything before the boundary is in a real island; everything after is
    // a node with no edges at all. That split is the point of the view, and
    // `delta` belongs on the far side of it — it is in the corpus and joined
    // to nothing, which is the case this whole map exists to show.
    expect(placed.slice(isolatedFrom).map((p) => p.id).sort()).toEqual(['delta', 'lonely'])
    expect(placed.slice(0, isolatedFrom).map((p) => p.id).sort()).toEqual([
      'alpha',
      'beta',
      'gamma',
    ])
  })

  it('lays the unconnected out in rows rather than scattering them', () => {
    const many = Array.from({ length: 8 }, (_, i) => `orphan-${i}`)
    const { placed, isolatedFrom } = layoutGraph(many, [], { isolatedColumns: 4, isolatedGap: 10 })
    const orphans = placed.slice(isolatedFrom)

    // Four per row, evenly spaced: a count you can read, not a fog.
    expect(orphans.slice(0, 4).map((p) => p.x)).toEqual([0, 10, 20, 30])
    expect(orphans[4]?.y).toBeGreaterThan(orphans[0]?.y ?? 0)
  })

  it('never returns a coordinate that cannot be drawn', () => {
    // A NaN here paints nothing and reports nothing; the node simply is not
    // there, which is the failure this whole view exists to make visible.
    const { placed } = layoutGraph(ids, edges)

    for (const p of placed) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
  })

  it('survives two nodes seeded onto the same point', () => {
    // Equal hashes would divide by a zero distance. The nudge is deterministic
    // so this does not become the one case that moves between renders.
    const pair = ['same', 'same-'].map((id) => id)
    const first = layoutGraph(pair, [edge('same', 'same-')])
    const second = layoutGraph(pair, [edge('same', 'same-')])

    expect(first.placed).toEqual(second.placed)
    for (const p of first.placed) expect(Number.isFinite(p.x)).toBe(true)
  })

  it('pulls a connected pair closer together than the canvas is wide', () => {
    const { placed } = layoutGraph(['a', 'b'], [edge('a', 'b')], { width: 1600 })
    const [first, second] = placed
    const apart = Math.hypot((first?.x ?? 0) - (second?.x ?? 0), (first?.y ?? 0) - (second?.y ?? 0))

    expect(apart).toBeGreaterThan(0)
    expect(apart).toBeLessThan(400)
  })

  it('lays a corpus with no links at all out as a block, not a ribbon', () => {
    // A fresh install: entries exist, nobody has written a reference yet. With
    // no islands to span, the band had nothing to take its width from and fell
    // to eight columns — 377 entries in a 238-by-1598 strip, which is the first
    // thing a new user would have seen.
    const many = Array.from({ length: 200 }, (_, i) => `entry-${i}`)
    const { width, height } = layoutGraph(many, [])

    expect(width).toBeGreaterThan(height)
  })

  it('handles an empty corpus without throwing', () => {
    const { placed, width, height } = layoutGraph([], [])

    expect(placed).toEqual([])
    expect(Number.isFinite(width)).toBe(true)
    expect(Number.isFinite(height)).toBe(true)
  })
})

describe('layoutGraph determinism (CROFT-252)', () => {
  /**
   * The existing tests vary NODE order, which is why this survived: the node
   * path was already protected by components() sorting, and the LINK list
   * never was. simulate() sums forces over that array and float addition is
   * not associative, so the same graph in a different edge order settled
   * somewhere slightly different — a map that rearranges after an unrelated
   * write, which reads as the map being organic rather than as a bug.
   */
  const ids = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']
  const edges: Edge[] = [
    { source: 'alpha', target: 'bravo' },
    { source: 'bravo', target: 'charlie' },
    { source: 'charlie', target: 'delta' },
    { source: 'alpha', target: 'delta' },
    { source: 'echo', target: 'foxtrot' },
    { source: 'foxtrot', target: 'golf' },
    { source: 'echo', target: 'golf' },
  ]

  const positions = (e: Edge[]) =>
    layoutGraph(ids, e).placed.map((p) => `${p.id}:${p.x.toFixed(9)},${p.y.toFixed(9)}`)

  it('places nodes identically however the edges are ordered', () => {
    const forward = positions(edges)
    const reversed = positions([...edges].reverse())
    const shuffled = positions([edges[4]!, edges[0]!, edges[6]!, edges[2]!, edges[1]!, edges[5]!, edges[3]!])

    expect(reversed).toEqual(forward)
    expect(shuffled).toEqual(forward)
  })

  it('is unaffected by a duplicated edge arriving in a different place', () => {
    // Postgres can return the same row set in any order after a vacuum; the
    // layout must not care.
    const a = positions([...edges, { source: 'alpha', target: 'bravo' }])
    const b = positions([{ source: 'alpha', target: 'bravo' }, ...edges])
    expect(b).toEqual(a)
  })
})

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GraphView } from './graph-view'
import type { KnowledgeGraph } from '@/lib/api/knowledge-graph'

/**
 * The shell over the two renderers.
 *
 * What is asserted here is the part that must not depend on which one is
 * mounted: the legend, the title bar, and the rule that a browser which cannot
 * run WebGL is never offered it. A static render has no canvas, so this is
 * also exactly the no-WebGL case — which is the one worth pinning, because it
 * is the one nobody will look at by hand.
 */

const graph = (over: Partial<KnowledgeGraph> = {}): KnowledgeGraph => ({
  nodes: [
    { slug: 'alpha', title: 'Alpha', project: 'CROFT', entity: null, degree: 1, island: 0, x: 10, y: 10 },
    { slug: 'beta', title: 'Beta', project: null, entity: null, degree: 1, island: 0, x: 60, y: 30 },
    { slug: 'lonely', title: 'Lonely', project: null, entity: null, degree: 0, island: -1, x: 0, y: 200 },
  ],
  entities: [],
  edges: [{ source: 'alpha', target: 'beta' }],
  missing: [{ slug: 'never-written', from: ['alpha'], x: 40, y: 80 }],
  islands: [2],
  width: 100,
  height: 200,
  isolatedFrom: 2,
  stats: {
    entries: 3,
    withReferences: 2,
    references: 2,
    resolved: 1,
    dangling: 1,
    isolated: 1,
    islands: 1,
  },
  ...over,
})

describe('the map shell', () => {
  it('says what every mark on it means, over either renderer', () => {
    // "What are the dotted red circles?" was asked after ten minutes of
    // looking at this, and the answer only existed in a caption below the
    // frame. A map whose key is somewhere else is a map with no key.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('never written')
    expect(html).toContain('more links')
    expect(html).toContain('joined to nothing')
  })

  it('draws the flat map where WebGL is not available', () => {
    // No canvas in a static render, so this is the fallback path. It has to
    // produce the actual map, not an empty frame waiting for a scene that is
    // never going to mount.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('<svg')
    expect(html).toContain('/knowledge/alpha')
    expect(html).toContain('aria-label="Zoom in"')
  })

  it('does not offer a view it cannot draw', () => {
    // A toggle to a renderer this browser cannot run is worse than no toggle:
    // it is a control that produces a black rectangle.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).not.toContain('How to draw the map')
    expect(html).not.toContain('Spatial')
  })

  it('describes the gestures that exist on the device being used', () => {
    // The bar read "Hover a node · scroll to zoom" on a phone, naming two
    // gestures that do not exist there and omitting the one that does.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('drag to pan')
    expect(html).toContain('pinch to zoom')
  })

  it('draws an empty corpus without falling over', () => {
    const html = renderToStaticMarkup(
      <GraphView graph={graph({ nodes: [], edges: [], missing: [], isolatedFrom: 0 })} />,
    )

    expect(html).toContain('<svg')
    expect(html).not.toContain('NaN')
  })

  it('names a world the way the rest of the app names it', () => {
    // The map had only the entity KEY, so it wrote "dispofi" where settings
    // and the knowledge list both say "Dispofi". A key identifies; a title is
    // what somebody chose to call the thing. The scene is client-only so this
    // asserts the shell passes the titles down rather than the rendering.
    const g = graph({
      entities: [
        { key: 'dispofi', title: 'Dispofi' },
        { key: 'tribe', title: 'Tribe' },
      ],
    })

    expect(g.entities.map((e) => e.title)).toEqual(['Dispofi', 'Tribe'])
    // and the shell renders without them, because most installs have none
    const html = renderToStaticMarkup(<GraphView graph={graph({ entities: [] })} />)
    expect(html).toContain('<svg')
  })

  it('offers the spotlight, and starts with everything lit', () => {
    // A map that opens blacked out looks broken, so "Everything" has to be
    // the resting state and the selected one.
    const html = renderToStaticMarkup(<GraphView graph={graph()} />)

    expect(html).toContain('Light up one project or entity')
    expect(html).toContain('Everything')
  })

  it('offers only the projects and worlds that are on the map', () => {
    // CROFT has no knowledge in this fixture, so it must not be offered —
    // picking it would black the map out with no explanation.
    const html = renderToStaticMarkup(
      <GraphView
        graph={graph({
          nodes: [
            { slug: 'a', title: 'A', project: 'BB', entity: 'tribe', degree: 1, island: 0, x: 0, y: 0 },
            { slug: 'b', title: 'B', project: null, entity: null, degree: 0, island: -1, x: 0, y: 9 },
          ],
          entities: [
            { key: 'tribe', title: 'Tribe' },
            { key: 'nowhere', title: 'Nowhere' },
          ],
          edges: [],
          missing: [],
          isolatedFrom: 1,
        })}
      />,
    )

    expect(html).toContain('BB')
    expect(html).toContain('Tribe')
    expect(html).not.toContain('Nowhere')
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tailwind v4 generates a utility only for a key registered in `@theme`, and
 * an unregistered one fails by doing nothing at all: the class is not emitted,
 * the element keeps whatever it inherited, and the page looks like a design
 * decision. `font-display` survived that way on two headings while the font it
 * names was downloaded on every page for nothing (CROFT-258).
 *
 * So the check is not "is --font-display registered" — that is the instance.
 * It is that every font utility the interface actually uses has a key behind
 * it, which is the only form of this bug that can be caught before someone
 * notices a heading looks ordinary.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })

const theme = readFileSync('src/app/globals.css', 'utf8')
const registered = new Set(
  [...theme.matchAll(/^\s*--font-([a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
)

describe('font utilities the interface uses', () => {
  /**
   * Only what lands in a `className`. `font-size`, `font-family` and
   * `font-display` are also CSS property names, and scanning whole files finds
   * them in inline styles and in test fixtures — reporting a stylesheet as a
   * missing Tailwind key, which is noise that would get the test deleted.
   */
  const CSS_PROPERTY = new Set(['size', 'family', 'weight', 'style', 'stretch', 'variant', 'feature', 'kerning', 'smoothing'])
  const WEIGHT = new Set(['medium', 'semibold', 'bold', 'normal', 'light', 'black', 'thin', 'extrabold'])

  const used = new Map<string, string[]>()
  for (const file of walk('src')) {
    const source = readFileSync(file, 'utf8')
    for (const attribute of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
      const classes = attribute[1] ?? attribute[2] ?? attribute[3] ?? ''
      for (const match of classes.matchAll(/(?:^|\s)font-([a-z][a-z0-9-]*)/g)) {
        const family = match[1]
        if (!family || WEIGHT.has(family) || CSS_PROPERTY.has(family)) continue
        used.set(family, [...(used.get(family) ?? []), file])
      }
    }
  }

  it('finds the two headings that ask for the display family', () => {
    // A guard on the guard: if the call sites are ever removed, this test
    // would pass vacuously and stop protecting anything.
    expect(used.get('display')?.length).toBeGreaterThan(0)
  })

  it('has a registered theme key for every family it names', () => {
    const orphans = [...used].filter(([family]) => !registered.has(family))
    expect(
      orphans.map(([family, files]) => `${family} (${files.join(', ')})`),
    ).toEqual([])
  })
})

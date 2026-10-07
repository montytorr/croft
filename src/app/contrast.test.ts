import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Every colour the interface sets text in, measured against every ground it can
 * land on, in both themes. WCAG 2 contrast: 4.5 for text, and no exceptions for
 * a disabled control: it is set in the muted ink on a flat ground, so its label
 * is measured here like any other (CROFT-34). Borders are not in this list.
 */
const css = readFileSync('src/app/globals.css', 'utf8')

const block = (selector: string) => {
  const start = css.indexOf(`\n${selector} {`)
  const end = css.indexOf('\n}', start)
  return css.slice(start, end)
}

const read = (body: string) => {
  const tokens: Record<string, string> = {}
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) tokens[m[1]!] = m[2]!
  return tokens
}

const light = read(block(':root'))
const dark = { ...light, ...read(block(':root.dark')) }

const channel = (v: number): number => {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}
export const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const GROUNDS = ['bg', 'bg-elevated', 'surface', 'surface-raised', 'surface-hover']
const INKS = [
  'fg', 'fg-muted', 'fg-subtle',
  'accent', 'danger',
  'status-backlog', 'status-todo', 'status-doing', 'status-in-review', 'status-done', 'status-cancelled',
  'stage-planned', 'stage-active', 'stage-completed', 'stage-dropped',
  'log-finding', 'log-decision', 'log-handoff',
  'type-feature', 'type-bug', 'type-improvement', 'type-chore', 'type-spike', 'type-docs',
  'priority-urgent', 'priority-high', 'priority-medium', 'priority-low',
]

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('text contrast, %s theme', (_name, tokens) => {
  it('reads the tokens it measures', () => {
    for (const key of [...GROUNDS, ...INKS]) expect(tokens[key], key).toMatch(/^#/)
  })

  it.each(INKS)('%s reads at 4.5:1 on every ground', (ink) => {
    for (const ground of GROUNDS) {
      expect(ratio(tokens[ink]!, tokens[ground]!), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps a disabled control readable: muted ink on the flat ground it sits on', () => {
    for (const ground of ['bg-elevated', 'surface', 'bg']) {
      expect(ratio(tokens['fg-muted']!, tokens[ground]!), `disabled label on ${ground}`).toBeGreaterThanOrEqual(4.5)
    }
    // The tick on a checked, disabled checkbox is a graphic: 3:1.
    expect(ratio(tokens['bg-elevated']!, tokens['fg-muted']!)).toBeGreaterThanOrEqual(3)
  })

  it('keeps a placeholder readable on the field it is in', () => {
    expect(ratio(tokens['fg-subtle']!, tokens.surface!)).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps heather text readable on its own tint, and white or ink on its fill', () => {
    expect(ratio(tokens.accent!, tokens['accent-subtle']!)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(tokens['accent-fg']!, tokens.accent!)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(tokens.danger!, tokens['danger-subtle']!)).toBeGreaterThanOrEqual(4.5)
  })
})

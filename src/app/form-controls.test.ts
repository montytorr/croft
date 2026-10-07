import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One look for every form control (CROFT-34).
 *
 * The look lives in globals.css, on the elements, so a control that brings its
 * own is the bug: a bare select with another font and a native arrow, a
 * disabled button gone to 1:1 under `disabled:opacity-50`, a dashed rim that
 * reads as unfinished. These checks keep the stylesheet's promises and keep
 * the markup from re-growing a private look. What a browser computes for each
 * control on each page is scripts/audit-controls.mjs; this is what can be
 * known without one.
 */
const css = readFileSync('src/app/globals.css', 'utf8')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : walk(path)
    return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [path] : []
  })

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

/** The kit is where the controls are defined, so it is the one file allowed to write them bare. */
const files = walk('src')
  .filter((path) => path !== 'src/components/ui/control.tsx')
  .map((path) => ({ path, source: stripComments(readFileSync(path, 'utf8')) }))

/** The opening tag starting at `from`: attributes run to the first `>` outside quotes and braces. */
const openingTag = (source: string, from: number) => {
  let depth = 0
  let quote = ''
  for (let i = from; i < source.length; i += 1) {
    const c = source[i]!
    if (quote) {
      if (c === quote) quote = ''
    } else if (depth === 0 && (c === '"' || c === "'")) quote = c
    else if (c === '{') depth += 1
    else if (c === '}') depth -= 1
    else if (c === '>' && depth === 0) return source.slice(from, i + 1)
  }
  return source.slice(from)
}

const tagsOf = (name: string) =>
  files.flatMap(({ path, source }) =>
    [...source.matchAll(new RegExp(`<${name}(?=[\\s>])`, 'g'))].map((m) => ({ path, tag: openingTag(source, m.index!) })),
  )

describe('the shared control look, in the stylesheet', () => {
  it('has exactly two heights: standard and compact', () => {
    expect(css).toMatch(/--control-h:\s*2\.75rem/)
    expect(css).toMatch(/--control-h:\s*2\.5rem/)
    expect(css).toMatch(/--control-h-sm:\s*2\.25rem/)
    expect(css.match(/--control-h[\w-]*:/g)?.length).toBe(3)
  })

  it('draws a select with no native chrome, a themed chevron, room for it and an ellipsis', () => {
    const select = css.slice(css.indexOf("  select {\n    padding-right"), css.indexOf("select option,"))
    expect(select).toContain('padding-right: 2.25rem')
    expect(select).toContain('background-image: var(--chevron)')
    expect(select).toContain('text-overflow: ellipsis')
    expect(css).toMatch(/select \{\n\s+-webkit-appearance: none;\n\s+appearance: none;/)
    expect(css).toContain('select::picker-icon')
    expect(css).toMatch(/:root\.dark \{\n\s+--chevron:/)
    expect(css).toMatch(/select option,\s+select optgroup \{[^}]*background-color: var\(--surface\)/)
  })

  it('answers hover, focus, disabled, invalid and placeholder', () => {
    expect(css).toMatch(/textarea:hover:not\(:disabled\):not\(:focus\)/)
    expect(css).toMatch(/textarea:focus \{[^}]*border-color: var\(--accent\)/)
    expect(css).toMatch(/textarea:disabled \{[^}]*opacity: 1/)
    expect(css).toMatch(/aria-invalid='true'\]:focus/)
    expect(css).toMatch(/textarea:user-invalid:focus/)
    expect(css).toMatch(/textarea::placeholder \{[^}]*opacity: 1/)
  })

  it('sets a disabled control solid, in the muted ink, on a flat ground', () => {
    const disabled = css.slice(css.indexOf('  input:disabled,\n  select:disabled'), css.indexOf('  input:disabled::placeholder'))
    expect(disabled).toContain('border-style: solid')
    expect(disabled).toContain('color: var(--fg-muted)')
    expect(disabled).toContain('background-color: var(--bg-elevated)')
    expect(disabled).not.toMatch(/dashed|dotted/)
    expect(css).toMatch(/\nbutton:disabled,\n\[role='button'\]\[aria-disabled='true'\] \{\n\s+opacity: 1;/)
  })

  it('gives a checkbox and a radio a target of at least 24px', () => {
    expect(css).toMatch(/width: 1\.125rem;\n\s+height: 1\.125rem;/)
    expect(css).toMatch(/input\[type='checkbox'\]::before,\n\s+input\[type='radio'\]::before \{\n\s+content: '';\n\s+position: absolute;\n\s+inset: -4px;/)
  })

  it('keeps the touch-screen rule that stops iOS zooming into a field', () => {
    expect(css).toMatch(/font-size: max\(16px, 1em\) !important/)
  })
})

describe('the markup does not grow a private look', () => {
  it('never fades a disabled control with opacity', () => {
    const offenders = files.filter(({ source }) => /disabled:opacity-/.test(source)).map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('never draws a button with a dashed rim', () => {
    const offenders = tagsOf('button')
      .filter(({ tag }) => /border-dashed|outline-dashed/.test(tag))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('writes no <select> that is not the kit select or an overlay on a chip', () => {
    const offenders = tagsOf('select')
      .filter(({ tag }) => !tag.includes('control-overlay'))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('writes no <textarea> that is not a field in a shell, an in-place title or a source surface', () => {
    const offenders = tagsOf('textarea')
      .filter(({ tag }) => !/control-bare|data-inline-edit|COMPOSER_FIELD|FIELD\b/.test(tag))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('writes no <input> with its own size, ground or font', () => {
    const offenders = tagsOf('input')
      .filter(({ tag }) => !/type="(file|color|checkbox|radio|hidden)"/.test(tag) && !/control-bare|control-overlay|readOnly|opacity-0/.test(tag))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })

  it('sets no control in the prose or code face', () => {
    const offenders = [...tagsOf('input'), ...tagsOf('textarea'), ...tagsOf('select')]
      .filter(({ tag }) => /font-(mono|serif)|writeup-sm/.test(tag) && !/data-surface/.test(tag))
      .map(({ path }) => path)
    expect(offenders).toEqual([])
  })
})

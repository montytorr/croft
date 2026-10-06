import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Italic is for prose, where it carries meaning: markdown emphasis, and the
 * blockquotes of a write-up. The interface around it (empty states, card and
 * row summaries, labels, the login page) is set upright and told apart by
 * colour, weight and size, because a slanted line of chrome read as a fault
 * (CROFT-32), and in a face with no drawn italic the browser fakes one.
 */

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : walk(path)
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
  })

/**
 * Files allowed to set an `italic` class: prose components only. Empty today,
 * since rendered markdown gets its italic from `<em>` and the stylesheet.
 * fonts.ts names 'italic' as a style axis to load, not as a class.
 */
const PROSE_FILES = new Set<string>([])
const NOT_CLASSES = new Set(['src/app/fonts.ts'])

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')

/** An `italic` utility, with any variants (`md:italic`), but not `not-italic`. */
const ITALIC_CLASS = /(?<![\w-])(?:[\w-]+:)*italic(?![\w-])/

const italicSelectors = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /font-style\s*:\s*italic/.test(body ?? ''))
    .flatMap(([, selector]) => (selector ?? '').split(',').map((s) => s.trim()))

describe('italic stays in prose', () => {
  it('recognises an italic class and leaves not-italic alone', () => {
    // A guard on the guard: if the pattern stopped matching, the scan below
    // would pass vacuously.
    expect(ITALIC_CLASS.test('className="text-sm italic"')).toBe(true)
    expect(ITALIC_CLASS.test("cn('md:italic', x)")).toBe(true)
    expect(ITALIC_CLASS.test('className="not-italic"')).toBe(false)
  })

  it('sets no italic class outside prose components', () => {
    const offenders = walk('src')
      .filter((file) => !PROSE_FILES.has(file) && !NOT_CLASSES.has(file))
      .filter((file) => ITALIC_CLASS.test(stripComments(readFileSync(file, 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('sets font-style: italic in the stylesheet only on prose selectors', () => {
    const selectors = italicSelectors(readFileSync('src/app/globals.css', 'utf8'))
    expect(selectors).toContain('.writeup blockquote')
    expect(selectors.filter((s) => !/^\.(writeup|prose-editor)\b/.test(s))).toEqual([])
  })
})

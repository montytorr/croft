import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The type scale has three sizes: `text-ui` (15px, 16px from 768px), `text-aux`
 * (13px, 14px) and `text-micro` (12px). Interface text under 13px was the
 * readability complaint, and it came back each time someone wrote a size in
 * place: `text-[0.6875rem]` is one line and looks harmless.
 *
 * So the rule is held here. A size under 0.8125rem is only allowed as
 * `text-micro`, and `text-micro` is only allowed on an uppercase label, which
 * is what makes 12px readable.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : walk(path)
    return /\.tsx$/.test(entry) && !/\.test\./.test(entry) ? [path] : []
  })

const files = walk('src').map((path) => ({ path, lines: readFileSync(path, 'utf8').split('\n') }))

const offenders = (pattern: RegExp, allowed: (line: string) => boolean = () => false) =>
  files.flatMap(({ path, lines }) =>
    lines.flatMap((line, i) => (pattern.test(line) && !allowed(line) ? [`${path}:${i + 1}`] : [])),
  )

describe('type scale', () => {
  it('has no arbitrary text size under 13px', () => {
    const bad = files.flatMap(({ path, lines }) =>
      lines.flatMap((line, i) =>
        [...line.matchAll(/text-\[(\d*\.?\d+)(rem|px)\]/g)].flatMap(([, size, unit]) =>
          Number(size) * (unit === 'rem' ? 16 : 1) < 13 ? [`${path}:${i + 1}`] : [],
        ),
      ),
    )
    expect(bad).toEqual([])
  })

  it('uses text-micro only on an uppercase label', () => {
    expect(offenders(/\btext-micro\b/, (line) => /uppercase/.test(line))).toEqual([])
  })

  it('has no text-xs, which is a second name for text-aux', () => {
    expect(offenders(/(?<![\w-])text-xs\b/)).toEqual([])
  })
})

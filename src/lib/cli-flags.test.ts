import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The CLI refuses flags it does not know, so the list of known flags has to be
 * right — and the first version was not.
 *
 * It was built by grepping `flags.X`, which missed every flag read dynamically:
 * `flags[k]` looping over ['type','status','priority'], and the [flag, field]
 * pairs in `run` and `session end`. It shipped, and `croft add --priority high`
 * — documented in the CLI's own help — started exiting 2.
 *
 * A whitelist is only as trustworthy as its enumeration, so this compares it
 * against the help text, which is the contract people actually read.
 */
const source = readFileSync(join(process.cwd(), 'cli/croft.mjs'), 'utf8')

/** JSDoc in this file discusses `flags.X` in prose; prose is not a read. */
const withoutComments = (): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const knownFlags = (): Set<string> => {
  const block = /const KNOWN_FLAGS = new Set\(\[([\s\S]*?)\]\)/.exec(source)
  if (!block) throw new Error('KNOWN_FLAGS not found in cli/croft.mjs')
  return new Set([...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!))
}

/** Flags named in the help text, which is what the CLI promises. */
const helpFlags = (): Set<string> => {
  const help = /const HELP = `([\s\S]*?)`/.exec(source) ?? /ALWAYS START HERE([\s\S]*?)`/.exec(source)
  const inherited = /const HELP_INHERITED = `([\s\S]*?)`/.exec(source)
  const text = help ? `${help[1]!}${inherited?.[1] ?? ''}` : source
  return new Set([...text.matchAll(/--([a-z][a-z0-9-]+)/g)].map((m) => m[1]!))
}

describe('KNOWN_FLAGS', () => {
  it('contains every flag the help text offers', () => {
    const known = knownFlags()
    const missing = [...helpFlags()].filter((flag) => !known.has(flag))
    expect(missing, `help offers flags the parser would reject: ${missing.join(', ')}`).toEqual([])
  })

  it('contains every flag read dynamically, which a grep for `flags.` misses', () => {
    const known = knownFlags()
    // ['type','status','priority'] style loops, and [flag, field] pairs.
    const dynamic = [
      ...source.matchAll(/for \(const \w+ of \[([^\]]+)\]\) if \(flags/g),
      ...source.matchAll(/for \(const \[flag, field\] of \[([\s\S]*?)\]\) \{/g),
    ]
      .flatMap((m) => [...m[1]!.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((x) => x[1]!))
      .filter((name) => !['exitCode', 'durationMs'].includes(name))

    expect(dynamic.length).toBeGreaterThan(5)
    const missing = dynamic.filter((flag) => !known.has(flag) && !/^[a-z]+[A-Z]/.test(flag))
    expect(missing, `dynamically read but not known: ${missing.join(', ')}`).toEqual([])
  })

  it('still knows the flag whose absence caused the regression', () => {
    expect(knownFlags().has('priority')).toBe(true)
  })

  /**
   * The two tests above compare the list against the help text and against the
   * dynamic loops. Neither sees a flag the code reads directly and the help
   * never mentions — `flags.somethingNew` — which the parser would refuse with
   * exit 2 while every test stayed green. That is the same failure as the
   * regression, one door over, so close it from the code's side too.
   */
  it('contains every flag the code reads directly', () => {
    const known = knownFlags()
    const read = [
      ...withoutComments().matchAll(/flags\.([a-z][a-z0-9]*)\b/g),
      ...withoutComments().matchAll(/flags\['([^']+)'\]/g),
    ].map((m) => m[1]!)

    expect(read.length).toBeGreaterThan(30)
    const missing = [...new Set(read)].filter((flag) => !known.has(flag))
    expect(missing, `read by the code but the parser would reject: ${missing.join(', ')}`).toEqual([])
  })

  /**
   * The parser keys by the flag exactly as typed — `flags[name]` where name is
   * `dry-run`, not `dryRun`. So a camelCase read is not a style choice, it is
   * dead code: permanently undefined, and silent about it.
   */
  it('has no camelCase reads, which could never match a parsed flag', () => {
    const camel = [...new Set([...withoutComments().matchAll(/flags\.([a-z]+[A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]!))]
    expect(camel, `flags.${camel.join(', flags.')} can never be set: the parser keys on the literal flag name`).toEqual([])
  })
})

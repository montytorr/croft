import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkReferences,
  closeSlugs,
  referenceRefusal,
  referenceWarnings,
  referencesIn,
  wikiRefsIn,
} from './knowledge-graph'

/**
 * A `[[reference]]` is a promise: follow it and you land on the fact. 70 of
 * them in the store resolve to nothing, and 44 of those point at a fact Croft
 * already holds under another slug — so the problem is not unwritten knowledge,
 * it is a name recalled slightly wrong and nothing on the way in that looked.
 *
 * These cover the three places that were silent: the write path that never
 * parsed a body, the task ref smuggled in wiki brackets, and the extractor
 * counting quoted code as links.
 */

const corpus = [
  'capsolver-akamai-script-bug',
  'seetickets-session-mechanics',
  'project-adp-client-read-email-only-join',
  'borrower-insurance-appointments',
  'proxy-buffer-defaults',
  'herdr-plugin-ecosystem-audit',
]

describe('references inside inline code are not references', () => {
  it('ignores a `[[table]]` quoted in prose, as the renderer already does', () => {
    // The real case: herdr-plugin-ecosystem-audit quotes three TOML table
    // headers, and they were counted as three references to entries nobody
    // ever wrote. The page showed backticks, the diagnostic showed defects,
    // and a map that disagrees with the page it maps is worse than none.
    const body =
      'The plugin manifest carries `[[startup]]`, `[[build]]` and `[[keys]]` tables. ' +
      'See [[herdr-plugin-ecosystem-audit]] for the rest.'

    expect(referencesIn(body)).toEqual(['herdr-plugin-ecosystem-audit'])
  })

  it('closes a span on its own backtick run, so ``a `b` c`` is all code', () => {
    expect(referencesIn('Use ``x `[[inner]]` y`` and [[real-one]].')).toEqual(['real-one'])
  })

  it('does not let two stray backticks in separate paragraphs swallow prose', () => {
    // A code span cannot cross a blank line — the paragraph ends first — so
    // the parser leaves both backticks literal and linkifies what is between
    // them. Treating them as a pair would hide real edges.
    const body = 'A stray ` and [[one-slug]].\n\nAnother paragraph ` with [[other-slug]].'

    expect(referencesIn(body).sort()).toEqual(['one-slug', 'other-slug'])
  })

  it('still ignores a fenced block, which was never the regression', () => {
    const body = ['Prose [[real-one]].', '```', 'croft know [[an-example]]', '```'].join('\n')

    expect(referencesIn(body)).toEqual(['real-one'])
  })

  it('keeps the spelling the author used beside the slug it resolves to', () => {
    expect(wikiRefsIn('See [[Cache_Warmup_Race]].')).toEqual([
      { raw: 'Cache_Warmup_Race', slug: 'cache-warmup-race' },
    ])
  })
})

describe('a task ref in wiki brackets', () => {
  it('is named as a task ref, not reported as unwritten knowledge', () => {
    // Six of these are in the store. The normaliser lower-cases `[[BB-192]]`
    // into `bb-192`, which has exactly the shape of a slug, so it was counted
    // as a fact somebody had forgotten to write.
    const report = checkReferences({ body: 'Caused by [[BB-192]].', known: corpus })

    expect(report.taskShaped.map((ref) => ref.raw)).toEqual(['BB-192'])
    expect(report.unresolved).toEqual([])
  })

  it('is refused, and told how to write it instead', () => {
    const report = checkReferences({ body: 'See [[dis-2129]] too.', known: corpus })
    const refusal = referenceRefusal(report)

    expect(refusal).toContain('task reference')
    expect(refusal).toContain('DIS-2129')
  })

  it('is refused even with allowUnresolvedRefs, because it is never right', () => {
    const report = checkReferences({ body: 'See [[bb-361]].', known: corpus })

    expect(referenceRefusal(report, { allowUnresolved: true })).toContain('task reference')
  })

  it('leaves a real entry that happens to look like a ref alone', () => {
    // `sha-256` has the shape of a task ref. It is also an entry somebody
    // wrote, and the lookup runs first, so shape never overrules existence.
    const report = checkReferences({ body: 'See [[sha-256]].', known: [...corpus, 'sha-256'] })

    expect(report.taskShaped).toEqual([])
    expect(report.unresolved).toEqual([])
  })
})

describe('naming the slugs a missing reference nearly is', () => {
  it('tolerates a type prefix the reference left off', () => {
    // `project-`, `reference-`, `feedback-`, `discovery-` survived the
    // claude-mem import into some slugs and not others, so "is the prefix part
    // of the name" is unanswerable from inside the store and gets guessed.
    expect(closeSlugs('adp-client-read-email-only-join', corpus)).toContain(
      'project-adp-client-read-email-only-join',
    )
  })

  it('tolerates a type prefix the reference invented', () => {
    // The same mistake in reverse, which the store also contains.
    expect(closeSlugs('project-borrower-insurance-appointments', corpus)).toContain(
      'borrower-insurance-appointments',
    )
  })

  it('treats a swapped type prefix as the same name rather than a near miss', () => {
    // The prefixes are interchangeable noise from the import, so
    // `reference-x` and `project-x` are one name wearing two hats. Scored on
    // words alone this reads as three words out of five — close enough to
    // mention, not close enough to act on — and the write would be waved
    // through with a warning instead of corrected.
    const report = checkReferences({
      body: 'See [[reference-adp-client-read-email-only-join]].',
      known: corpus,
    })

    expect(report.unresolved[0]?.suggestions[0]).toBe(
      'project-adp-client-read-email-only-join',
    )
    expect(report.unresolved[0]?.certain).toBe(true)
  })

  it('finds the longer name a shorter reference is contained in', () => {
    expect(closeSlugs('capsolver-akamai-bug', corpus)).toEqual(['capsolver-akamai-script-bug'])
    expect(closeSlugs('seetickets-session', corpus)).toEqual(['seetickets-session-mechanics'])
  })

  it('does not suggest an entry that merely shares one word', () => {
    // `session` sits inside a dozen slugs. One word in common is a
    // coincidence, and a suggestion that is wrong is worse than none.
    expect(closeSlugs('redis-session', corpus)).toEqual([])
  })

  it('offers nothing for a reference to something genuinely unwritten', () => {
    expect(closeSlugs('kafka-consumer-lag-alerting', corpus)).toEqual([])
  })
})

describe('what the write path does about it', () => {
  it('refuses a reference whose fact the store already holds, and names it', () => {
    const report = checkReferences({
      body: 'Root cause is [[capsolver-akamai-bug]].',
      known: corpus,
    })
    const refusal = referenceRefusal(report)

    expect(report.unresolved[0]?.certain).toBe(true)
    expect(refusal).toContain('[[capsolver-akamai-script-bug]]')
  })

  it('accepts a reference to something nobody has written, and says so', () => {
    // Two entries that cite each other cannot both be written first, so this
    // is refused nowhere — but it is never silent either. Silence is how 70
    // of these accumulated.
    const report = checkReferences({ body: 'Next: [[kafka-consumer-lag-alerting]].', known: corpus })

    expect(referenceRefusal(report)).toBeNull()
    expect(referenceWarnings(report)).toEqual([
      '[[kafka-consumer-lag-alerting]] points at no entry — write it, or correct the reference.',
    ])
  })

  it('lets a caller insist, once it has been told what the store has', () => {
    const report = checkReferences({ body: 'See [[capsolver-akamai-bug]].', known: corpus })

    expect(referenceRefusal(report, { allowUnresolved: true })).toBeNull()
    expect(referenceWarnings(report)[0]).toContain('[[capsolver-akamai-script-bug]]')
  })

  it('resolves an entry citing itself, which is not written yet by definition', () => {
    const report = checkReferences({
      body: 'As [[proxy-buffer-defaults-v2]] explains.',
      slug: 'proxy-buffer-defaults-v2',
      known: corpus,
    })

    expect(report.unresolved).toEqual([])
  })

  it('says nothing about a body whose references all resolve', () => {
    const report = checkReferences({ body: 'See [[proxy_buffer_defaults]].', known: corpus })

    expect(report).toEqual({ taskShaped: [], unresolved: [] })
  })
})

/**
 * The check is worth nothing where it is not called. POST was the one write
 * path that never parsed a body — it ran the schema and inserted — so this
 * pins the wiring, which no pure test can see.
 */
describe('POST /api/v1/knowledge resolves references before inserting', () => {
  const route = readFileSync(
    join(process.cwd(), 'src/app/api/v1/knowledge/route.ts'),
    'utf8',
  )

  it('checks the body against the corpus', () => {
    expect(route).toContain('checkReferences')
    expect(route).toContain('knownSlugs')
  })

  it('refuses before it writes, not after', () => {
    const refusesAt = route.indexOf('referenceRefusal')

    expect(refusesAt).toBeGreaterThan(-1)
    expect(refusesAt).toBeLessThan(route.indexOf('createKnowledge(actor'))
  })

  it('returns the warnings with the entry it accepted', () => {
    expect(route).toContain('referenceWarnings')
    expect(route).toMatch(/warnings/)
  })
})

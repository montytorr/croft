import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 055 rewrites the search_all that is INSTALLED, not the one any single file
 * wrote. This test reconstructs that definition the way 053's test does — 038
 * is the newest file to define the function, 048 then edited it in place — and
 * runs 055's replacements against it, so the anchors are checked against the
 * text Postgres will really be handed.
 *
 * Checking that they appear is not enough on its own: `replace` returns its
 * input when it finds nothing and reports success, which is how 048 shipped a
 * definition nobody had written. So the rewrite is applied here and the result
 * asserted.
 */

const migration = (name: string) => readFileSync(join(process.cwd(), 'migrations', name), 'utf8')

/** What 048 did to every workspace RPC. Same transform as 053's test. */
const asInstalledBy048 = (sql: string) =>
  sql
    .replace(/[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id\s*=\s*p_owner\s+and\s+/g, '')
    .replace(/where\s+[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id\s*=\s*p_owner/gi, 'where true')
    .replace(/and\s+[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id\s*=\s*p_owner/gi, 'and true')

const INSTALLED = asInstalledBy048(migration('038_check_scopes_knowledge.sql'))
const BOTH_ARMS = migration('055_search_stop_suppressing_the_fallback.sql')

/**
 * The anchors are dollar-quoted rather than escaped, so what the file says is
 * byte-for-byte what Postgres searches for and this test needs no unescaping
 * step to guess at. Three `$old$` blocks, two `$new$` ones: the third old
 * block — the widening floor — is replaced with nothing.
 */
const blocks = (tag: string) =>
  [...BOTH_ARMS.matchAll(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`, 'g'))].map(
    (m) => m[1] as string,
  )

const olds = blocks('old')
const news = blocks('new')
const REPLACEMENTS: [string, string, string][] = [
  ['the query CTE', olds[0] as string, news[0] as string],
  ['the precise arm', olds[1] as string, news[1] as string],
  ['the widening floor', olds[2] as string, ''],
]

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

const REWRITTEN = REPLACEMENTS.reduce((sql, [, from, to]) => sql.replace(from, to), INSTALLED)

describe('055 edits the definition that is installed', () => {
  it('transforms rather than re-copying a body', () => {
    // Re-pasting 033 or 020 would revert 038's knowledge scoping and 048's
    // tenancy edit, which is the failure 048's own header warns about.
    expect(BOTH_ARMS).toContain('pg_get_functiondef')
    expect(BOTH_ARMS).not.toContain('create or replace function search_all')
  })

  it('refuses to run where the function is missing', () => {
    expect(BOTH_ARMS).toContain("raise exception 'search_all is not installed'")
  })

  it('is idempotent the way 051 and 054 are', () => {
    expect(BOTH_ARMS).toContain("raise notice 'search_all already runs both arms")
  })

  it('found three anchors and two replacements to write in their place', () => {
    expect(olds).toHaveLength(3)
    expect(news).toHaveLength(2)
  })

  for (const [what, from] of REPLACEMENTS) {
    it(`anchors on text that exists exactly once: ${what}`, () => {
      expect(occurrences(INSTALLED, from), `${what} is not in the installed definition`).toBe(1)
    })
  }

  for (const [what] of REPLACEMENTS) {
    it(`refuses to guess when ${what} is not there`, () => {
      expect(BOTH_ARMS).toMatch(/raise exception 'search_all: expected exactly one .*, found %'/)
    })
  }
})

describe('055 stops the precise arm suppressing the fallback', () => {
  it('removes the floor that switched the wide arm off', () => {
    // The whole bug: three irrelevant rows satisfying an AND over thirteen
    // words were enough to stop the arm that answers the question. Live, on
    // the day this was written, `croft check "AWS list calls returning partial
    // results without any error"` returned four such rows and nothing else.
    expect(occurrences(INSTALLED, '(select count(*) from precise) < p_min_precise')).toBe(1)
    expect(REWRITTEN).not.toContain('< p_min_precise')
  })

  it('leaves the wide arm running and still de-duplicated', () => {
    expect(REWRITTEN).toContain('and c.vec @@ q.wide')
    // A row both arms find appears once, in the precise head: its better
    // evidence. Without this the merge double-counts.
    expect(REWRITTEN).toContain('c.id not in (select precise.id from precise)')
  })

  it('keeps the head ahead of the tail', () => {
    expect(REWRITTEN).toContain('hits.widened asc')
  })
})

describe('055 makes the precise arm N of M', () => {
  it('counts distinctive terms instead of ANDing the whole question', () => {
    expect(INSTALLED).toContain('where c.vec @@ q.precise')
    expect(REWRITTEN).toContain('(select count(*) from terms t where c.vec @@ t.tq) >= q.threshold')
  })

  it('takes half the terms, and never fewer than two', () => {
    expect(REWRITTEN).toContain('greatest(2, ceil((select count(*) from terms) / 2.0))::int')
  })

  it('counts only the terms the configuration keeps', () => {
    // `does`, `their`, `than`, `after` and `itself` are English stopwords:
    // plainto_tsquery returns an empty query for them, no row can ever match
    // one, and four of the 22 evaluation queries carry one. Counting them
    // would put the threshold out of reach for exactly those questions.
    expect(REWRITTEN).toContain("where numnode(plainto_tsquery('english', term)) > 0")
  })

  it('still asks the whole question when there is nothing to widen to', () => {
    // One distinctive term means no OR query and no wide arm behind this one,
    // so `supavisor` must keep matching the way it always has.
    expect(REWRITTEN).toContain('when q.wide is null then c.vec @@ q.precise')
    expect(REWRITTEN).toContain('when q.wide is null then p_limit')
  })

  it('treats an OR query of nothing but stopwords as no OR query at all', () => {
    // `does their than aws` yields three terms the configuration discards and
    // an EMPTY tsquery, which is not a null one. Without the nullif, that
    // question would take the widened branch, match nothing, and lose the
    // whole-question fallback that used to answer it on `aws`.
    expect(REWRITTEN).toContain("end, ''::tsquery) as wide")
  })

  it('ranks both arms on the same query, so the merge is one ordering', () => {
    expect(REWRITTEN).toContain('ts_rank(c.vec, coalesce(q.wide, q.precise)) as rank')
    expect(REWRITTEN).toContain('order by ts_rank(c.vec, coalesce(q.wide, q.precise)) desc')
  })

  it('caps the promotion so a row that just misses the bar cannot be buried', () => {
    // Measured: en-04's CROFT-246 carries 2 of its query's 5 live terms, one
    // short of the threshold. Uncapped it would sink beneath every qualifying
    // row in the corpus; capped it moves from rank 6 to at worst rank 9.
    expect(REWRITTEN).toContain('least(p_limit, greatest(p_min_precise, 1))')
  })
})

describe('055 costs nothing an earlier migration installed', () => {
  it('keeps 038 scoping knowledge by project and entity', () => {
    expect(REWRITTEN).toContain('join project_entities ep on ep.entity_id = ke.entity_id')
  })

  it('keeps 033 demoting a superseded claim below its correction', () => {
    expect(REWRITTEN).toContain("case when hits.status = 'superseded' then 0.4 else 1 end")
  })

  it('keeps 048 out of the owner predicates', () => {
    expect(REWRITTEN).not.toContain('owner_user_id = p_owner')
  })

  it('asserts all of that in the migration itself, not only here', () => {
    // This test knows what 038, 033 and 048 left behind. The database is the
    // only thing that knows what is really installed, so the same three checks
    // run there, against the text about to be executed.
    expect(BOTH_ARMS).toContain(
      "raise exception 'search_all: the rewrite lost behaviour an earlier migration installed'",
    )
    expect(BOTH_ARMS).toContain("raise exception 'search_all: the widening floor survived")
  })
})

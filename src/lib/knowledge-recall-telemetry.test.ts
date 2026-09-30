import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = (name: string) => readFileSync(join(process.cwd(), 'migrations', name), 'utf8')

const RECALL = migration('053_knowledge_recall_telemetry.sql')

/**
 * What 048 did to every workspace RPC, reproduced here so the anchors 053
 * replaces can be checked against the definition that is actually installed
 * rather than against the one 027 wrote. Re-copying the 027 body instead would
 * revive the tenancy filters 048 removed, which is the failure 048's own header
 * warns about and 051 established the pattern for avoiding.
 */
const asInstalledBy048 = (sql: string) =>
  sql
    .replace(/[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id\s*=\s*p_owner\s+and\s+/g, '')
    .replace(/where\s+[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id\s*=\s*p_owner/gi, 'where true')
    .replace(/and\s+[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id\s*=\s*p_owner/gi, 'and true')

/**
 * The migration writes its anchors as SQL string literals: quotes doubled,
 * newlines escaped, adjacent literals concatenated across source lines. Undo
 * exactly that, so the test compares the text Postgres will search for.
 */
const asPostgresWillSeeIt = (sql: string) =>
  sql
    .replace(/'\s*\n\s*'/g, '')
    .replace(/\\n/g, '\n')
    .replace(/''/g, "'")

const INSTALLED = asInstalledBy048(migration('027_memory_use_widened.sql'))
const REWRITES = asPostgresWillSeeIt(RECALL)

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

/**
 * The three pieces of croft_memory_use that 053 rewrites. `replace` in Postgres
 * is global, so each of these must appear exactly once in the installed
 * definition or the rewrite would land somewhere nobody intended.
 */
const ANCHORS: [string, string][] = [
  ['the final select', 'select jsonb_build_object('],
  [
    'the tasksFiled key',
    "  'tasksFiled', (select count(*) from own o, bounds b where o.created_at >= b.window_start),",
  ],
  [
    'the end of the tasksFiledWithoutChecking predicate',
    "          and s.created_at between o.created_at - interval '30 minutes' and o.created_at\n      )\n  ),",
  ],
]

describe('053 records which entries a search returned', () => {
  it('adds the column without rewriting the history it cannot know about', () => {
    expect(RECALL).toContain('alter table search_events add column if not exists returned_slugs text[]')
    // No default: `{}` would turn every pre-existing row into a claim that the
    // search returned nothing, which nobody recorded.
    expect(RECALL).not.toMatch(/returned_slugs text\[\][^;]*default/)
    expect(RECALL).toContain('comment on column search_events.returned_slugs')
  })
})

describe('053 records direct recall by slug', () => {
  it('keeps direct reads out of search_events', () => {
    // Reusing search_events would move `searches`, `zeroResults` and the
    // widening rate, which are the three numbers 024/026/027 exist to produce.
    expect(RECALL).toContain('create table if not exists knowledge_reads')
    expect(RECALL).not.toMatch(/insert into search_events/i)
  })

  it('records the miss as a column, not as an absent row', () => {
    expect(RECALL).toMatch(/hit\s+boolean not null/)
  })

  it('indexes the three questions the table exists to answer', () => {
    for (const index of [
      'knowledge_reads_owner_idx',
      'knowledge_reads_actor_idx',
      'knowledge_reads_slug_idx',
    ]) {
      expect(RECALL, `053 omits ${index}`).toContain(index)
    }
  })

  it('is idempotent in the way the other migrations are', () => {
    expect(occurrences(RECALL, 'if not exists')).toBeGreaterThanOrEqual(5)
    expect(RECALL).toContain("raise notice 'croft_memory_use already counts direct reads")
  })
})

describe('053 transforms croft_memory_use rather than re-copying it', () => {
  it('reads the installed definition instead of pasting an old body', () => {
    expect(RECALL).toContain('pg_get_functiondef')
    expect(RECALL).not.toContain('create or replace function croft_memory_use')
  })

  it('refuses to run against a database where the function is missing', () => {
    expect(RECALL).toContain("raise exception 'croft_memory_use is not installed'")
  })

  it('asserts every rewrite landed, the way 051 does', () => {
    expect(RECALL).toContain("raise exception 'croft_memory_use: the final select was not found'")
    expect(RECALL).toContain(
      "raise exception 'croft_memory_use: rewrite did not produce all four changes'",
    )
  })

  for (const [what, anchor] of ANCHORS) {
    it(`replaces text that exists exactly once: ${what}`, () => {
      expect(occurrences(INSTALLED, anchor), `${what} is not in the installed definition`).toBe(1)
      expect(REWRITES, `053 no longer anchors on ${what}`).toContain(anchor)
    })
  }

  it('reports direct reads alongside the search numbers, never inside them', () => {
    for (const key of ["'directReads'", "'directReadMisses'", "'recentSlugMisses'"]) {
      expect(REWRITES, `053 omits ${key}`).toContain(key)
    }
    // The existing keys keep their meaning: nothing in the rewrite touches them.
    for (const untouched of ["'searches'", "'widened'", "'zeroResults'"]) {
      expect(REWRITES).not.toContain(`${untouched}, (select count(*) from reads`)
    }
  })

  it('counts a direct read as having consulted the memory before filing work', () => {
    // Looking a fact up by name is checking. tasksFiledWithoutChecking asked
    // search_events only, so an agent that recalled a slug and then filed still
    // read as having filed blind.
    expect(REWRITES).toContain('select 1 from knowledge_reads r')
    expect(REWRITES).toContain(
      "r.created_at between o.created_at - interval '30 minutes' and o.created_at",
    )
  })
})

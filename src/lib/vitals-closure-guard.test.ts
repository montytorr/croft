import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The closure finding's predicate, checked where it actually lives.
 *
 * It lives in SQL, inside a function no migration has ever written out in
 * full: 048 stripped the owner predicates, 050 added actor_type, 051 added the
 * closure CTE, each by transforming the definition installed before it. 050's
 * header records what happens when one of them re-copies an older body
 * instead — it reverted every fix made since, and only the integration suite
 * caught it.
 *
 * So the one thing that can go wrong silently here is the SEARCH text. If 054
 * looks for a CTE that differs from what 051 left behind by a single space,
 * the migration raises on deploy rather than at review, and until then the
 * finding keeps counting the wrong population while the code says otherwise.
 * This compares the two sources against each other rather than trusting
 * either, and checks the events the new predicate names against the list the
 * database will actually accept — the lesson of 032, which listed events from
 * memory and failed the deploy.
 */
const repo = process.cwd()
const migrations = join(repo, 'migrations')

const read = (file: string) => readFileSync(join(migrations, file), 'utf8')

/**
 * The text a run of adjacent SQL string constants evaluates to.
 *
 * Postgres concatenates constants separated by whitespace containing a
 * newline, and a run beginning with `E'...'` stays an escape string across the
 * continuation, so `\n` is a newline throughout and `''` is one quote.
 */
const literalRun = (slice: string) =>
  [...slice.matchAll(/'((?:[^']|'')*)'/g)]
    .map((m) => (m[1] as string).replaceAll("''", "'").replaceAll('\\n', '\n'))
    .join('')

const between = (source: string, start: string, end: string) => {
  const from = source.indexOf(start)
  expect(from, `expected to find ${JSON.stringify(start)}`).toBeGreaterThan(-1)
  const to = source.indexOf(end, from + start.length)
  expect(to, `expected to find ${JSON.stringify(end)}`).toBeGreaterThan(-1)
  return source.slice(from + start.length, to + end.length)
}

const evidence = read('054_vitals_closure_evidence.sql')
const original = read('051_vitals_closed_unclaimed.sql')

/** What 051 inserts into the function: the CTE, then the final select it displaced. */
const insertedBy051 = literalRun(
  between(original, "E'select jsonb_build_object(',", "'select jsonb_build_object('"),
)
const searchedFor = literalRun(between(evidence, 'old_cte :=', "'  )';"))
const replacementCte = literalRun(between(evidence, 'new_cte :=', "'  )';"))

/** Every event the database will accept, from the last migration to say so. */
const allowedEvents = () => {
  const files = readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  let allowed: Set<string> | null = null
  for (const file of files) {
    const match =
      /constraint\s+task_activity_events_event_check[\s\S]*?check\s*\(event in \(([\s\S]*?)\)\s*\)/i.exec(
        read(file),
      )
    if (!match?.[1]) continue
    allowed = new Set([...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string))
  }
  return allowed
}

/** Every event name the predicate tests, from both `in (...)` and `= '...'`. */
const eventsNamedBy = (sql: string) => {
  const names = new Set<string>()
  for (const group of sql.matchAll(/e\.event\s+in\s*\(([^)]*)\)/g)) {
    for (const name of (group[1] as string).matchAll(/'([a-z_]+)'/g)) names.add(name[1] as string)
  }
  for (const one of sql.matchAll(/e\.event\s*=\s*'([a-z_]+)'/g)) names.add(one[1] as string)
  return names
}

describe('054 replaces the predicate 051 actually installed', () => {
  it('searches for the CTE 051 inserts, byte for byte', () => {
    // 051 inserts the CTE and re-emits the final select it anchored on; 054
    // replaces the CTE alone and leaves that select where it is.
    expect(insertedBy051).toBe(`${searchedFor}\nselect jsonb_build_object(`)
  })

  it('refuses rather than silently doing nothing when that text is absent', () => {
    // `replace` returns its input unchanged when it finds nothing, so a
    // migration that trusts it reports success and changes the predicate not
    // at all. 051's own header makes the same point about its own rewrite.
    expect(evidence).toContain('strpos(definition, old_cte) = 0')
    expect(evidence).toMatch(/refusing to guess/)
    expect(evidence).toContain('raise exception')
  })

  it('transforms the installed definition rather than re-copying an older one', () => {
    // The 050 mistake: a copied body reverts 048's owner predicates and every
    // transformation since. There must be no create-or-replace of the function
    // in this file at all.
    expect(evidence).toContain('pg_get_functiondef(fn)')
    expect(evidence.toLowerCase()).not.toContain('create or replace function croft_vitals')
  })

  it('is re-runnable', () => {
    expect(evidence).toContain("definition like '%closedWithoutTrace%'")
    expect(evidence).toContain('raise notice')
  })
})

describe('the predicate counts work nobody could see, not work nobody claimed', () => {
  it('excludes a close made by a person', () => {
    // Humans are documented as never claiming and claim.ts refuses to claim
    // for them, so their closes measured the design, not a lapse. The check
    // twenty lines above this one in vitals.ts already excluded them.
    expect(replacementCte).toContain('e.actor_type')
    expect(replacementCte).toContain("<> 'human'")
    expect(replacementCte).toContain("'resolved'")
    // Unknown provenance is read as a runtime, exactly as agent-silent reads a
    // payload too old to carry actorType.
    expect(replacementCte).toContain("'agent'")
  })

  it('treats a status move, a commit, a push and a test run as evidence', () => {
    // The ten tasks CROFT-251 classified: none was the bare created->done
    // shape, nine had moved to in-review hours earlier, several carried
    // commits and test runs. None of them was invisible.
    for (const event of ['claimed', 'checkpointed', 'git_commit', 'git_push', 'run_result']) {
      expect(replacementCte).toContain(`'${event}'`)
    }
    expect(replacementCte).toContain("'status_changed'")
  })

  it('does not treat the move that closes the task as evidence', () => {
    // Every close writes a status_changed to done or cancelled. Counting it
    // would make the finding count nothing at all, forever, and look fixed.
    expect(replacementCte).toMatch(/not in \('done', 'cancelled'\)/)
  })

  it('looks only between filing and close', () => {
    expect(replacementCte).toContain('e.created_at <= t.resolved_at')
  })

  it('names only events the database accepts', () => {
    // 032 listed events from memory, missed one production already held, and
    // failed the deploy. A predicate naming an event nothing ever writes is
    // the quieter version of the same mistake: it just never matches.
    const allowed = allowedEvents()
    expect(allowed).not.toBeNull()
    const named = eventsNamedBy(replacementCte)
    expect(named.size).toBeGreaterThan(0)
    for (const event of named) expect([...(allowed as Set<string>)]).toContain(event)
  })

  it('renames the count with its meaning', () => {
    // A server on 051 sends closedUnclaimed, which answers a different
    // question about a different population. Keeping the name would have left
    // a number whose meaning depended on the migration level underneath it.
    expect(replacementCte).toContain('closed_without_trace')
    expect(replacementCte).not.toContain('closed_unclaimed')
    expect(evidence).toContain("'''closedWithoutTrace'', c.closed_without_trace'")
    expect(evidence).toContain("updated like '%closed_unclaimed%'")
  })

  it('leaves balanced SQL behind', () => {
    let depth = 0
    for (const char of replacementCte) {
      if (char === '(') depth += 1
      if (char === ')') depth -= 1
      expect(depth).toBeGreaterThanOrEqual(-1)
    }
    // The run opens with `,\n  closure_stats as (` and closes it, so the CTE
    // itself balances; the leading comma is not a paren.
    expect(depth).toBe(0)
  })
})

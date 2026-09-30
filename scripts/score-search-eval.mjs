#!/usr/bin/env node
/**
 * Scores `croft check` against tests/fixtures/search-eval.json.
 *
 * WHY THIS EXISTS. The fixture was created by CROFT-247 to stop retrieval
 * changes being guessed at, and for one release it could not do that job: it
 * recorded the queries and the expected refs but not the INVOCATION, and the
 * invocation decides the answer. `croft check "<q>"`, `--project CROFT` and
 * `--kinds knowledge` return three different orderings of the same store, so
 * two people re-scoring the same file got different numbers and neither was
 * wrong. That is CROFT-259.
 *
 * So the scope is read from the file, never re-derived by whoever is running
 * it, and the run records what produced the numbers — the server build, the
 * CLI version, the size of the store — because the previous baseline moved
 * 0.73 -> 0.82 on the day it was written without a line of code changing.
 * A number with no provenance rots silently; this one says when it stopped
 * being true.
 *
 * It shells out to the real CLI on purpose. Calling search_all directly would
 * measure the database; what is under test is what an agent actually gets back
 * from the command it is told to run first.
 *
 *   node scripts/score-search-eval.mjs                 score, print the report
 *   node scripts/score-search-eval.mjs --write         also rewrite `baseline`
 *   node scripts/score-search-eval.mjs --case en-07    one case, with its rows
 *   node scripts/score-search-eval.mjs --cli ./cli/croft.mjs
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

const FIXTURE = new URL('../tests/fixtures/search-eval.json', import.meta.url)

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : (argv[i + 1] ?? '')
}
const has = (name) => argv.includes(`--${name}`)

const CLI = flag('cli') ?? 'croft'
const ONLY = flag('case')
/**
 * Which function is under test. `all` is search_all, the path `croft check`
 * takes and the one the recorded baseline measures. `tasks` is search_tasks —
 * a different function with its own ranking, which the web UI and
 * `croft check --tasks` use, and which migration 055 deliberately did not
 * touch (CROFT-260). Scoring it means dropping the cases whose answer is a
 * knowledge slug or a session, because that arm can never return one: a miss
 * there would measure the filter, not the ranking.
 */
const ARM = flag('arm') ?? 'all'
const TASK_REF = /^[A-Z][A-Z0-9]{1,9}-\d+$/

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

/** The exact argv a case is scored with. Printed so a human can re-run one by hand. */
const invocation = (kase) => {
  const scope = kase.scope ?? {}
  const args = ['check', kase.query, '--json']
  if (scope.project) args.push('--project', scope.project)
  if (scope.kinds?.length) args.push('--kinds', scope.kinds.join(','))
  if (scope.tasksOnly || ARM === 'tasks') args.push('--tasks')
  return args
}

const croft = async (args) => {
  // `croft` on PATH is a copy that may itself be stale (CROFT-261), so the
  // version it reports is recorded beside the numbers rather than assumed.
  const node = CLI.endsWith('.mjs') ? ['node', [CLI, ...args]] : [CLI, args]
  const { stdout } = await run(node[0], node[1], { maxBuffer: 16 * 1024 * 1024 })
  const payload = JSON.parse(stdout)
  return payload.data ?? payload
}

const score = (kase, response) => {
  const rows = response.results ?? []
  const wanted = new Set(kase.expectedRefs)
  const at = rows.findIndex((r) => wanted.has(r.ref))
  const hit = at !== -1
  return {
    id: kase.id,
    lang: kase.lang,
    rank: hit ? at + 1 : null,
    reciprocal: hit ? 1 / (at + 1) : 0,
    // `loose` is per row: whether THIS answer came from the widened arm. Since
    // migration 055 both arms always run, so the response-level `widened` flag
    // means "nothing cleared the precise arm" and is no longer the same
    // measurement the 2026-09-21 baseline recorded under that name.
    precise: hit ? rows[at].loose !== true : false,
    widened: response.widened === true,
    returned: rows.length,
    top5: rows.slice(0, 5).map((r) => r.ref),
  }
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const round = (n) => Math.round(n * 1000) / 1000

const summarise = (scored) => ({
  n: scored.length,
  'recall@20': round(mean(scored.map((s) => (s.rank !== null ? 1 : 0)))),
  'recall@5': round(mean(scored.map((s) => (s.rank !== null && s.rank <= 5 ? 1 : 0)))),
  rank1: scored.filter((s) => s.rank === 1).length,
  mrr: round(mean(scored.map((s) => s.reciprocal))),
  precise_hits: scored.filter((s) => s.precise).length,
  queries_widened: scored.filter((s) => s.widened).length,
})

/**
 * What the numbers were measured against. Two of these move without anyone
 * touching retrieval — which is the whole reason the previous baseline
 * disagreed with itself on the day it was written.
 */
const provenance = async () => {
  const [health, projects] = await Promise.all([
    fetch(`${process.env.CROFT_BASE_URL ?? baseUrlFromEnvFile()}/api/v1/health`)
      .then((r) => r.json())
      .then((p) => p.data)
      .catch(() => null),
    croft(['projects', '--json']).catch(() => null),
  ])
  const rows = projects?.results ?? projects ?? []
  return {
    serverVersion: health?.version ?? null,
    serverBuild: health?.build ?? null,
    corpus: {
      projects: Array.isArray(rows) ? rows.length : null,
      // Every task ever filed, including closed ones — monotone, so it dates
      // the store the way a commit count dates a branch.
      tasksEverFiled: Array.isArray(rows)
        ? rows.reduce((a, p) => a + (p.task_counter ?? 0), 0)
        : null,
    },
  }
}

const baseUrlFromEnvFile = () => {
  try {
    const env = readFileSync(`${process.env.HOME}/.croft/env`, 'utf8')
    return env.match(/^CROFT_BASE_URL=(.*)$/m)?.[1]?.trim() ?? 'http://localhost:3000'
  } catch {
    return 'http://localhost:3000'
  }
}

const main = async () => {
  let cases = fixture.cases.filter((c) => !ONLY || c.id === ONLY)
  if (ARM === 'tasks') {
    const scorable = cases.filter((c) => c.expectedRefs.every((r) => TASK_REF.test(r)))
    process.stdout.write(
      `arm=tasks: ${scorable.length} of ${cases.length} cases have a task-shaped answer; ` +
        `the rest expect knowledge and are not scorable against search_tasks\n`,
    )
    cases = scorable
  }
  if (cases.length === 0) {
    process.stderr.write(`no case "${ONLY}" in the fixture\n`)
    process.exit(1)
  }

  const scored = []
  for (const kase of cases) {
    const args = invocation(kase)
    let response
    try {
      response = await croft(args)
    } catch (error) {
      process.stderr.write(`${kase.id}: ${error.message}\n`)
      process.exit(1)
    }
    const result = score(kase, response)
    scored.push(result)
    const where = args.slice(3).join(' ') || '(no scope)'
    process.stdout.write(
      `${kase.id.padEnd(6)} ${String(result.rank ?? '—').padStart(3)}  ` +
        `${result.precise ? 'precise' : result.rank ? 'loose  ' : '       '}  ${where}\n`,
    )
    if (ONLY) for (const [i, r] of (response.results ?? []).entries()) {
      process.stdout.write(`   ${String(i + 1).padStart(2)}  ${r.loose ? ' ' : '*'} ${r.kind} ${r.ref}\n`)
    }
  }

  const byLang = {}
  for (const lang of [...new Set(scored.map((s) => s.lang))]) {
    byLang[lang] = summarise(scored.filter((s) => s.lang === lang))
  }
  const overall = summarise(scored)

  process.stdout.write(`\noverall  ${JSON.stringify(overall)}\n`)
  for (const [lang, s] of Object.entries(byLang)) process.stdout.write(`${lang.padEnd(8)} ${JSON.stringify(s)}\n`)

  if (!has('write')) return
  if (ARM !== 'all') {
    process.stderr.write('the recorded baseline is search_all; refusing to overwrite it with another arm\n')
    process.exit(1)
  }
  if (ONLY) {
    process.stderr.write('refusing to write a baseline from a single case\n')
    process.exit(1)
  }

  const prov = await provenance()
  let cliVersion = null
  try {
    cliVersion = (await run(...(CLI.endsWith('.mjs') ? ['node', [CLI, '--version']] : [CLI, ['--version']]))).stdout.trim()
  } catch {}

  fixture.baseline = {
    measuredAt: new Date().toISOString(),
    how: 'node scripts/score-search-eval.mjs --write — each case run with its own `scope`, limit 20',
    system: fixture.baseline?.system ?? null,
    ...prov,
    cliVersion,
    overall,
    by_lang: byLang,
    ranks: Object.fromEntries(scored.map((s) => [s.id, s.rank])),
    top5: Object.fromEntries(scored.map((s) => [s.id, s.top5])),
    findings: fixture.baseline?.findings ?? [],
  }
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`)
  process.stdout.write(`\nbaseline rewritten in tests/fixtures/search-eval.json\n`)
}

await main()

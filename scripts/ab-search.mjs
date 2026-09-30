#!/usr/bin/env node
/**
 * Prints an A/B harness for a retrieval migration: the evaluation set scored
 * against the installed function, the migration applied, the same set scored
 * again, and a ROLLBACK.
 *
 * WHY A TRANSACTION. There is one database. Scoring a ranking change means
 * running it against the real store, and the only honest control is the same
 * store at the same instant — a "before" taken yesterday is confounded by
 * every task filed since, which is how the 2026-09-21 baseline moved 0.73 ->
 * 0.82 in a day without a line of code changing (CROFT-259). Inside a
 * transaction, `create or replace function` is visible only to this session
 * and the rollback puts it back, so production never sees the candidate.
 *
 * IT PRINTS, IT DOES NOT RUN. The output is SQL on stdout; piping it at a
 * database is a decision, and it stays one.
 *
 *   node scripts/ab-search.mjs migrations/056_*.sql --owner <uuid> > /tmp/ab.sql
 *
 * Only the cases whose expectedRefs are all task-shaped are scored: the rest
 * expect a knowledge slug, which search_tasks can never return, so a miss
 * there would measure the kind filter and not the ranking. ALL of a case's
 * expectedRefs count — several of them list two or three rows that answer the
 * question equally well, and taking only the first scores a correct answer as
 * a regression.
 */
import { readFileSync } from 'node:fs'

const [migration, ...rest] = process.argv.slice(2)
if (!migration) {
  process.stderr.write('usage: node scripts/ab-search.mjs <migration.sql> --owner <uuid>\n')
  process.exit(1)
}
const owner = rest[rest.indexOf('--owner') + 1]
if (!owner || !/^[0-9a-f-]{36}$/.test(owner)) {
  process.stderr.write('--owner <uuid> is required: the store belongs to someone\n')
  process.exit(1)
}

const fixture = JSON.parse(
  readFileSync(new URL('../tests/fixtures/search-eval.json', import.meta.url), 'utf8'),
)

/**
 * Kept in step with distinctiveTerms() in src/lib/api/search.ts by hand.
 * The API computes p_terms and passes them in, so a harness that computed
 * them differently would be scoring a query nobody ever runs.
 */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'what',
  'why', 'how', 'are', 'was', 'were', 'not', '但', 'les', 'des', 'une', 'dans',
  'pour', 'avec', 'sur', 'est', 'sont', 'pas', 'que', 'qui',
])
const distinctiveTerms = (query) =>
  [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 3 && !STOP.has(w)))].slice(0, 8)

const TASK_REF = /^[A-Z][A-Z0-9]{1,9}-\d+$/
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const arr = (xs) => `array[${xs.map(lit).join(',')}]::text[]`

const cases = fixture.cases.filter((c) => c.expectedRefs.every((r) => TASK_REF.test(r)))

const rows = cases
  .map((c) => `  (${lit(c.id)}, ${lit(c.lang)}, ${lit(c.query)}, ${arr(distinctiveTerms(c.query))}, ${arr(c.expectedRefs)})`)
  .join(',\n')

process.stdout.write(`\\set ON_ERROR_STOP on
begin;

create temp table eval_cases(id text, lang text, q text, terms text[], expected text[]) on commit drop;
insert into eval_cases values
${rows};

create temp table eval_scores(phase text, id text, lang text, rank int, loose boolean) on commit drop;

create or replace function pg_temp.score(p text) returns void language plpgsql as $harness$
declare c record; pos int; w boolean;
begin
  for c in select * from eval_cases order by id loop
    -- row_number() over an unordered window numbers the rows in the order the
    -- function produced them, which is the ranking under test.
    select s.rn, s.widened into pos, w from (
      select (t.project_key || '-' || t.number) as ref, t.widened, row_number() over () as rn
        from search_tasks(${lit(owner)}::uuid, c.q, c.terms, null, null, null, 20, 3) t
    ) s where s.ref = any(c.expected) order by s.rn limit 1;
    if not found then pos := null; w := null; end if;
    insert into eval_scores values (p, c.id, c.lang, pos, w);
  end loop;
end
$harness$;

select pg_temp.score('before');

${readFileSync(migration, 'utf8')}

select pg_temp.score('after');

\\echo '=== per case ==='
select b.id, b.lang,
       coalesce(b.rank::text, '-') as before_rank,
       coalesce(a.rank::text, '-') as after_rank,
       coalesce(b.loose::text, '') as before_loose,
       coalesce(a.loose::text, '') as after_loose
  from eval_scores b
  join eval_scores a on a.id = b.id and a.phase = 'after'
 where b.phase = 'before'
 order by b.id;

\\echo '=== summary ==='
select phase, count(*) as n,
       round(avg(case when rank is not null then 1 else 0 end)::numeric, 3) as "recall@20",
       round(avg(case when rank is not null and rank <= 5 then 1 else 0 end)::numeric, 3) as "recall@5",
       count(*) filter (where rank = 1) as rank1,
       round(avg(case when rank is not null then 1.0 / rank else 0 end)::numeric, 3) as mrr,
       count(*) filter (where loose is false) as precise_hits
  from eval_scores group by phase order by phase desc;

\\echo '=== by lang ==='
select phase, lang, count(*) as n,
       round(avg(case when rank is not null then 1 else 0 end)::numeric, 3) as "recall@20",
       round(avg(case when rank is not null then 1.0 / rank else 0 end)::numeric, 3) as mrr
  from eval_scores group by phase, lang order by lang, phase desc;

-- Nothing is kept. The candidate existed for the length of this transaction.
rollback;
`)

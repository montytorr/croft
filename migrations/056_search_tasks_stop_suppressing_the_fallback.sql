-- ===========================================================================
-- 056: the same fix as 055, on the function the UI actually calls
--
-- 055 changed `search_all`. `search_tasks` was left alone on purpose, because
-- extending an unscored change to a second function is how you ship something
-- and never learn whether it helped (CROFT-260). It has now been scored, and
-- this is what the measurement says.
--
-- WHAT WAS MEASURED, 2026-09-21, against the live store, by applying this
-- migration inside a transaction and rolling it back — same store, same
-- instant, only the function different. The harness is scripts/ab-search.mjs.
--
-- 1. THE EVALUATION SET SAYS IT COSTS ALMOST NOTHING. On the 15 cases in
--    tests/fixtures/search-eval.json whose answer is a task — the other 7
--    expect a knowledge slug, which this arm can never return, so scoring
--    them here would measure the filter and not the ranking:
--
--                     recall@20  recall@5  rank1    MRR  precise_hits
--      before             0.933     0.867      9  0.717             2
--      after              0.933     0.867      9  0.706            12
--
--    Nothing is lost and nothing is found. One case moves down (fr-12,
--    1 -> 4) and two move up (en-03 4 -> 3, xl-01 2 -> 1). fr-12 is the
--    cost of the head, exactly as bounded: three [V4] prompt tasks carry 4
--    of the 7 terms and the answer carries 3, so they lead it by 3 places
--    and no more. On this evidence alone the change is not worth making.
--
-- 2. REAL TRAFFIC SAYS OTHERWISE, AND IT IS THE SAME DEFECT. In 90 days,
--    607 searches ran with kinds=['task'] and only 27 widened. Most of that
--    is not the bug: 580 are `croft add`'s duplicate probe, which ORs its own
--    terms before sending them, so the precise arm legitimately matches.
--    Excluding those and short queries leaves 23 real natural-language
--    questions, of which 3 did not widen — and those 3 are what the eval set
--    cannot see, because the suppression never fires on any case in it.
--
--    All three are transformed. "claim on note annotation vs work" returned
--    a Queue-it pause, an algorithm port, an incident and a Flashbuy crash;
--    it now returns CROFT-146 "Auto-claim on note cannot tell annotating a
--    task from working on it" at rank 1, followed by three more tasks about
--    claiming. "scaffold hydration temporary cartNeed magic link scoping"
--    gains BB-357 "scaffold hydration is 100% dead" and BB-324 "magic-link
--    dedup"; "issue #2 issue #4 reported by a user of the repo" gains the
--    repo and GitHub tasks in place of five unrelated ones.
--
-- SO THE TRADE IS: one case in fifteen loses three places, on a question
-- that was already answered, in exchange for the questions that were not
-- answered at all. Recall does not move either way. That is the same trade
-- 055 made on search_all, and it is now measured on both sides rather than
-- argued.
--
-- AND THE DIVERGENCE GOES. `croft check "x"` and `croft check "x" --tasks`
-- are the same gate with a filter. Since 055 they ranked by different rules
-- and only one of them could suppress its own fallback.
--
-- THREE CHANGES, ONE FUNCTION, all of them 055's:
--
-- 1. THE FLOOR GOES. Both arms always run and are merged. Nothing is
--    double-counted: `wide` already excludes rows found by `precise`.
--
-- 2. THE PRECISE ARM BECOMES N-OF-M over distinctiveTerms(): a row qualifies
--    when it carries at least half of the terms the text-search configuration
--    actually keeps, never fewer than two. This is a SUPERSET of the arm it
--    replaces — matching every word of the question implies matching every
--    distinctive term in it — so no row that used to come back precise stops
--    coming back. The head is capped at p_min_precise places, which is what
--    that parameter now means here as it does in search_all.
--
-- 3. COVERAGE STOPS LYING. The precise arm reported `cardinality(p_terms)` —
--    every term in the question — for every row it returned. That was merely
--    uninformative while the arm demanded all of them; with an N-of-M
--    predicate it is false, and `coverage` is returned to the caller and used
--    as the tie-break after rank. It is now counted the same way the wide arm
--    counts it.
--
-- TRANSFORMED, NOT RE-COPIED. See 055, 054, 051 and 048: a migration that
-- pastes an older body silently reverts every transformation since. This
-- edits the definition actually installed, each anchor must appear exactly
-- once, and every intended change must be visible in the text about to be
-- executed.
-- ===========================================================================

do $migration$
declare
  fn oid;
  definition text;
  updated text;
  old_q text;
  new_q text;
  old_precise text;
  new_precise text;
  old_floor text;
  found int;
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'search_tasks';

  if fn is null then
    raise exception 'search_tasks is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%056: both arms run%' then
    raise notice 'search_tasks already runs both arms; nothing to do';
    return;
  end if;

  -- ---------------------------------------------------------------------
  -- 1. The query CTE gains the term list, the OR query and the threshold.
  -- ---------------------------------------------------------------------
  old_q := $old$  q as (select websearch_to_tsquery('english', p_query) as precise),$old$;

  new_q := $new$  -- 056: both arms run and the precise one asks for N of M terms.
  terms as (
    -- The distinctive terms as the text-search configuration will actually
    -- see them, built once rather than once per candidate row. The filter is
    -- not tidiness: `does`, `their`, `than`, `after` and `itself` are English
    -- stopwords, dropped from the OR query and unmatchable by any row, so a
    -- question carrying one would face a threshold counting a term the corpus
    -- cannot supply.
    select plainto_tsquery('english', term) as tq
      from unnest(coalesce(p_terms, '{}'::text[])) as term
     where numnode(plainto_tsquery('english', term)) > 0
  ),

  q as (
    select
      websearch_to_tsquery('english', p_query) as precise,
      -- nullif, because `q.wide is null` is the test for "there is no OR query
      -- to widen to", and a question whose every distinctive term is an
      -- English stopword produces an EMPTY tsquery rather than a null one.
      nullif(case
        when p_terms is not null and cardinality(p_terms) >= 2
        then websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))
      end, ''::tsquery) as wide,
      -- N of M. Half the live terms, and never fewer than two.
      greatest(2, ceil((select count(*) from terms) / 2.0))::int as threshold
  ),$new$;

  found := (length(definition) - length(replace(definition, old_q, ''))) / length(old_q);
  if found <> 1 then
    raise exception 'search_tasks: expected exactly one query CTE to replace, found %', found;
  end if;
  updated := replace(definition, old_q, new_q);

  -- ---------------------------------------------------------------------
  -- 2. The precise arm stops ANDing the whole question, and counts what it
  --    actually matched.
  -- ---------------------------------------------------------------------
  old_precise := $old$  precise as (
    select v.*, ts_rank(v.search_vector, q.precise) as rank,
           cardinality(coalesce(p_terms, '{}')) as coverage, false as widened
    from visible v, q
    where v.search_vector @@ q.precise
    order by ts_rank(v.search_vector, q.precise) desc
    limit p_limit
  ),$old$;

  new_precise := $new$  precise as (
    select v.*,
           ts_rank(v.search_vector, coalesce(q.wide, q.precise)) as rank,
           -- Counted, not assumed. The arm no longer demands every term, so
           -- reporting every term as covered would be wrong, and `coverage`
           -- is both returned to the caller and used to break rank ties.
           (select count(*)::int from terms t where v.search_vector @@ t.tq) as coverage,
           false as widened
    from visible v, q
    where case
            -- One distinctive term or none: there is no OR query to count
            -- coverage against and no widened arm behind this one, so the
            -- whole question stays the test, exactly as before.
            when q.wide is null then v.search_vector @@ q.precise
            else v.search_vector @@ q.wide
                 and (select count(*) from terms t where v.search_vector @@ t.tq) >= q.threshold
          end
    order by ts_rank(v.search_vector, coalesce(q.wide, q.precise)) desc
    -- A head, not a block. Both arms now rank on the same ts_rank, so a row
    -- that clears the threshold is never jumped by one that does not, and
    -- capping the promotion bounds what a near-miss row can cost at
    -- p_min_precise places rather than sinking it beneath every qualifying
    -- row in the corpus.
    --
    -- p_min_precise kept its name and its place in the signature — dropping a
    -- parameter means dropping the function, and with it every grant — but
    -- not its old job. It was the floor below which the fallback was
    -- suppressed. It is now the size of the confident head.
    limit (select case when q.wide is null then p_limit
                       else least(p_limit, greatest(p_min_precise, 1)) end from q)
  ),$new$;

  found := (length(updated) - length(replace(updated, old_precise, ''))) / length(old_precise);
  if found <> 1 then
    raise exception 'search_tasks: expected exactly one precise CTE to replace, found %', found;
  end if;
  updated := replace(updated, old_precise, new_precise);

  -- ---------------------------------------------------------------------
  -- 3. The suppression goes. This is the whole of the bug.
  -- ---------------------------------------------------------------------
  old_floor := $old$
      and (select count(*) from precise) < p_min_precise$old$;

  found := (length(updated) - length(replace(updated, old_floor, ''))) / length(old_floor);
  if found <> 1 then
    raise exception 'search_tasks: expected exactly one widening floor to remove, found %', found;
  end if;
  updated := replace(updated, old_floor, '');

  -- ---------------------------------------------------------------------
  -- Every change must be visible in the text about to be executed. A
  -- `replace` that found nothing returns its input and reports success, which
  -- is how 048 shipped a definition nobody had written.
  -- ---------------------------------------------------------------------
  if updated = definition then
    raise exception 'search_tasks: the rewrites produced no change';
  end if;
  if updated like '%< p_min_precise%' then
    raise exception 'search_tasks: the widening floor survived the rewrite';
  end if;
  if updated not like '%056: both arms run%'
     or updated not like '%numnode(plainto_tsquery%'
     or updated not like '%>= q.threshold%'
     or updated not like '%from terms t where v.search_vector @@ t.tq%' then
    raise exception 'search_tasks: the rewrite did not produce all three changes';
  end if;
  -- What this migration must NOT have cost: the project, type and status
  -- filters the callers rely on, the resolution tie-break from 007, and 048's
  -- removal of the owner predicates.
  if updated not like '%p_project is null or p.key = upper(p_project)%'
     or updated not like '%(h.resolution is not null) desc%'
     or updated like '%owner_user_id = p_owner%' then
    raise exception 'search_tasks: the rewrite lost behaviour an earlier migration installed';
  end if;

  execute updated;
end
$migration$;

-- Said on the parameter itself, because its name now reads as the opposite of
-- what it does and the next person will look here first.
comment on function search_tasks(uuid, text, text[], text, text, text, int, int) is
  'Task-only prior-work retrieval, used by the web UI and by `croft check '
  '--tasks`. Both arms always run and are merged: the precise arm returns rows '
  'carrying at least half the distinctive terms, the wide arm everything '
  'matching any of them, and a row found by both appears once, in the precise '
  'head. p_min_precise no longer gates the wide arm — it caps how many precise '
  'rows lead the answer.';

-- ===========================================================================
-- 055: both arms run, and the precise one asks a question a row can answer
--
-- CROFT-247 was filed as "search is English-stemmed word overlap and half the
-- corpus is French". The spike measured it and the premise did not survive.
-- French is the BEST-served subset (recall@20 0.92 against 0.43 for English),
-- English Snowball handles Latinate French morphology, and the 'simple'
-- configuration — the cheap fix the task recommended — makes things worse
-- (MRR 0.772 -> 0.633 on an offline replay of all 3,376 titles). None of that
-- is what this migration changes. The defect is the precise arm.
--
-- WHAT THE PRECISE ARM DOES TODAY. `websearch_to_tsquery('english', p_query)`
-- ANDs every content word of the question. An agent running the mandatory
-- first gate types a sentence of nine to thirteen words, so the arm demands a
-- row containing all thirteen. Over the whole corpus it matched the expected
-- row 0 times in 88 offline query x config combinations, and 3 times in 22
-- live searches. What it does match is long rows that happen to contain every
-- word somewhere across a description and a comment thread.
--
-- WHY THAT IS WORSE THAN USELESS. The wide arm — an OR of distinctiveTerms()
-- — only ran `when (select count(*) from precise) < p_min_precise`. So three
-- irrelevant rows were enough to switch off the arm that answers the
-- question. Demonstrated live and re-verified while writing this:
--
--   croft check "AWS list calls returning partial results without any error"
--     -> 4 precise rows, all irrelevant, widening suppressed, correct entry absent
--   same query with one nonsense word appended (precise arm -> 0 rows)
--     -> widening fires, `unpaginated-aws-list-calls-...` comes back at rank 7
--
-- Same corpus, same question. The only difference was whether four irrelevant
-- rows existed. And the widening rate 026 called a warning sign is, in this
-- measurement, the opposite: 20 of 22 eval queries widened and 16 of those
-- hit, while both queries that did NOT widen missed.
--
-- TWO CHANGES, ONE FUNCTION.
--
-- 1. THE FLOOR GOES. Both arms always run and are merged. Nothing is
--    double-counted: `wide` already excludes `c.id not in (select id from
--    precise)`, so a row found by both appears once, in the precise block,
--    which is its better evidence.
--
-- 2. THE PRECISE ARM BECOMES N-OF-M over distinctiveTerms() instead of
--    all-of-everything: a row qualifies when it carries at least half of the
--    terms the text-search configuration actually keeps. Half, because it is
--    the highest bar the evaluation set will bear — the lowest coverage of
--    any row tests/fixtures/search-eval.json calls correct is exactly half
--    the live terms (fr-09, 3 of 6; fr-05 and fr-07, 3 of 5). One case sits
--    below it (en-04's CROFT-246, 2 of 5), which is why the promotion is
--    capped rather than unbounded; see the `limit` below. Never fewer than
--    two terms, because one word is not a question.
--
--    This arm is a SUPERSET of the one it replaces: matching every word of
--    the question implies matching every distinctive term in it, so no row
--    that used to come back precise stops coming back.
--
-- BOTH ARMS ARE NOW RANKED BY THE SAME ts_rank, on the OR query, so the merge
-- is coherent: the head is the same ordering as the tail, filtered. A row that
-- clears the threshold therefore cannot be jumped by one that does not, and
-- the only rows the head can push down are rows that failed it.
--
-- WHAT IS NOT CHANGED, DELIBERATELY. The 'english' configuration stays: the
-- spike scored 'simple', english||french and unaccent, and only the union
-- vector won anything at all (one case in 22, inside the noise). The
-- superseded demotion from 033 stays. pgvector is still the right answer for
-- the cross-lingual cases and is still the expensive one; steps 1 and 2 here
-- are cheaper than its backfill script alone.
--
-- TRANSFORMED, NOT RE-COPIED, and asserted rather than trusted. See 054, 051
-- and 048: a migration that pastes an older body silently reverts every
-- transformation since — 048's owner predicates, 038's knowledge scoping.
-- This edits the definition actually installed. The anchors are written as
-- dollar-quoted text rather than as escaped literals so that what the file
-- says is byte-for-byte what Postgres searches for, and each one must appear
-- exactly once or the migration refuses to guess.
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
   where n.nspname = 'public' and p.proname = 'search_all';

  if fn is null then
    raise exception 'search_all is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%055: both arms run%' then
    raise notice 'search_all already runs both arms; nothing to do';
    return;
  end if;

  -- ---------------------------------------------------------------------
  -- 1. The query CTE gains the term list and the threshold.
  -- ---------------------------------------------------------------------
  old_q := $old$  q as (
    select
      websearch_to_tsquery('english', p_query) as precise,
      case
        when p_terms is not null and cardinality(p_terms) >= 2
        then websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))
      end as wide
  ),$old$;

  new_q := $new$  -- 055: both arms run and the precise one asks for N of M terms.
  terms as (
    -- The distinctive terms as the text-search configuration will actually
    -- see them, built once rather than once per candidate row.
    --
    -- The filter is not tidiness. `does`, `their`, `than`, `after` and
    -- `itself` are English stopwords: they are dropped from the OR query and
    -- `vec @@ plainto_tsquery('english', 'does')` can never be true, so a
    -- question carrying one would face a threshold counting a term no row in
    -- the corpus can supply. Four of the 22 evaluation queries carry one.
    select plainto_tsquery('english', term) as tq
      from unnest(coalesce(p_terms, '{}'::text[])) as term
     where numnode(plainto_tsquery('english', term)) > 0
  ),

  q as (
    select
      websearch_to_tsquery('english', p_query) as precise,
      -- nullif, because `q.wide is null` is now the test for "there is no OR
      -- query to widen to", and a query whose every distinctive term is an
      -- English stopword produces an EMPTY tsquery rather than a null one.
      -- Without this, a question like "does their than aws" would lose the
      -- whole-question fallback to a query that can match nothing.
      nullif(case
        when p_terms is not null and cardinality(p_terms) >= 2
        then websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))
      end, ''::tsquery) as wide,
      -- N of M. Half the live terms, and never fewer than two.
      greatest(2, ceil((select count(*) from terms) / 2.0))::int as threshold
  ),$new$;

  found := (length(definition) - length(replace(definition, old_q, ''))) / length(old_q);
  if found <> 1 then
    raise exception 'search_all: expected exactly one query CTE to replace, found %', found;
  end if;
  updated := replace(definition, old_q, new_q);

  -- ---------------------------------------------------------------------
  -- 2. The precise arm stops ANDing the whole question.
  -- ---------------------------------------------------------------------
  old_precise := $old$  precise as (
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, q.precise) as rank, false as widened
    from candidates c, q
    where c.vec @@ q.precise
    order by ts_rank(c.vec, q.precise) desc
    limit p_limit
  ),$old$;

  new_precise := $new$  precise as (
    -- At least half of the distinctive terms, counted per row, instead of
    -- every content word of the sentence. See the header: the old predicate
    -- matched the expected row 0 times in 88 offline combinations, and the
    -- rows it did match were three-word coincidences in long descriptions.
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, coalesce(q.wide, q.precise)) as rank, false as widened
    from candidates c, q
    where case
            -- One distinctive term or none: there is no OR query to count
            -- coverage against and no widened arm behind this one, so the
            -- whole question stays the test, exactly as before.
            when q.wide is null then c.vec @@ q.precise
            else c.vec @@ q.wide
                 and (select count(*) from terms t where c.vec @@ t.tq) >= q.threshold
          end
    order by ts_rank(c.vec, coalesce(q.wide, q.precise)) desc
    -- A head, not a block. Both arms rank on the same ts_rank, so a row that
    -- clears the threshold is never jumped by one that does not; the only
    -- thing the head can cost is a correct row that falls just under it, and
    -- capping the promotion bounds that at p_min_precise places instead of
    -- sinking it beneath every qualifying row in the corpus. Measured worst
    -- case on the evaluation set: en-04, rank 6 -> 9, still returned.
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
    raise exception 'search_all: expected exactly one precise CTE to replace, found %', found;
  end if;
  updated := replace(updated, old_precise, new_precise);

  -- ---------------------------------------------------------------------
  -- 3. The suppression goes. This is the whole of the bug.
  -- ---------------------------------------------------------------------
  old_floor := $old$
      and (select count(*) from precise) < p_min_precise$old$;

  found := (length(updated) - length(replace(updated, old_floor, ''))) / length(old_floor);
  if found <> 1 then
    raise exception 'search_all: expected exactly one widening floor to remove, found %', found;
  end if;
  updated := replace(updated, old_floor, '');

  -- ---------------------------------------------------------------------
  -- Every change must be visible in the text about to be executed. A
  -- `replace` that found nothing returns its input and reports success, which
  -- is how 048 shipped a definition nobody had written.
  -- ---------------------------------------------------------------------
  if updated = definition then
    raise exception 'search_all: the rewrites produced no change';
  end if;
  if updated like '%< p_min_precise%' then
    raise exception 'search_all: the widening floor survived the rewrite';
  end if;
  if updated not like '%055: both arms run%'
     or updated not like '%numnode(plainto_tsquery%'
     or updated not like '%>= q.threshold%'
     or updated not like '%from terms t where c.vec @@ t.tq%' then
    raise exception 'search_all: the rewrite did not produce all three changes';
  end if;
  -- What this migration must NOT have cost: 038's knowledge scoping, 033's
  -- demotion of superseded rows, and 048's removal of the owner predicates.
  if updated not like '%join project_entities ep on ep.entity_id = ke.entity_id%'
     or updated not like '%case when hits.status = ''superseded'' then 0.4 else 1 end%'
     or updated like '%owner_user_id = p_owner%' then
    raise exception 'search_all: the rewrite lost behaviour an earlier migration installed';
  end if;

  execute updated;
end
$migration$;

-- Said on the parameter itself, because its name now reads as the opposite of
-- what it does and the next person will look here first.
comment on function search_all(uuid, text, text[], text, text[], int, int) is
  'Prior-work retrieval over tasks, notes, knowledge and sessions. Both arms '
  'always run and are merged: the precise arm returns rows carrying at least '
  'half the distinctive terms, the wide arm everything matching any of them, '
  'and a row found by both appears once, in the precise head. p_min_precise no '
  'longer gates the wide arm — it caps how many precise rows lead the answer.';

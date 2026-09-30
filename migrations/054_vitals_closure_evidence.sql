-- ===========================================================================
-- 054: the closure finding counts work nobody could SEE, not work nobody claimed
--
-- 051 shipped a reader for the number CROFT-135 measured once and never
-- recomputed. The number is sound; the population it counts is not, and the
-- finding's own sentence is now false of it.
--
-- CROFT-251 reproduced it independently, by paging /api/v1/activity back to
-- the feed origin (4,228 events) and applying 051's predicate by hand: 10 of
-- 41 closes in a 24h window, against vitals reporting 11 of 42 at the same
-- moment. Classifying all ten by what happened between created and resolved:
--
--   never-claimed: 10 | bare created->done: 0 | had other work evidence: 10
--
-- ZERO were the BOTHY-13 shape this was filed about. Nine moved to in-review
-- first, often hours earlier, several with commits and test runs recorded
-- against the task. So "Nothing recorded that anyone was working them, so the
-- board showed them free while they were being done" describes none of them.
-- The board showed them in-review.
--
-- TWO DEFECTS, both in the CTE below.
--
-- 1. HUMAN CLOSES WERE COUNTED. Humans are documented as never claiming
--    (skills/croft/SKILL.md, AGENTS.md) and shouldClaimByWorking in
--    src/lib/api/claim.ts returns false for a non-agent BY DESIGN: "Humans
--    coordinate by talking, and a person leaving a comment does not mean they
--    have picked the work up." 051 selected `from own_tasks t` with no actor
--    filter, so every one of those by-design non-claims arrived as a lapse.
--    Meanwhile the agent-silent check sitting directly above it in
--    src/lib/api/vitals.ts does `if (agent.actorType === 'human') continue`,
--    for the same reason 050 gave. Two findings in one report, one of them
--    excluding people and the other not.
--
-- 2. THE DOCUMENTED SWEEP WAS COUNTED AS FAILURE. skills/croft/SKILL.md tells
--    an agent triaging a backlog to file ONE task for the sweep, claim that,
--    "and work the rest without claiming them" — because claiming thirty-one
--    tasks falsely asserts thirty-one pieces of in-flight work. Doing exactly
--    what the skill says produced thirty unclaimed closes, indistinguishable
--    in the metric from the failure the metric exists to catch.
--
-- THE DECISION, which is the whole of CROFT-251: is the question "was this
-- claimed", or "was there any evidence of work by anyone at any point"? The
-- second. The finding exists to catch work that was INVISIBLE WHILE IT WAS
-- HAPPENING, and a task that moved to in-review with commits against it was
-- not invisible — whatever the claim log says about it. A claim is one way of
-- being visible, not the only one, and it is the only one 051 could see.
--
-- So the predicate becomes: closed in the window, closed by an agent, and
-- with nothing at all recorded between filing and close that anyone was on it
-- — no claim, no checkpoint, no status move off the status it was filed in,
-- no commit, no push, no test run. The terminal transition is not evidence,
-- because every close writes one; that is what `to not in (done, cancelled)`
-- is for, and without it this would count nothing at all, forever, and look
-- like an improvement.
--
-- The payload key changes with the meaning: closedUnclaimed becomes
-- closedWithoutTrace. It is cheap here — nothing but assess() ever read it —
-- and it is the point. A server still on 051 sends the old key, the new check
-- does not find the new one, and it says nothing, which is correct: a check
-- that cannot see the number must not invent one. Leaving the name alone
-- would have left a number whose meaning silently depended on the migration
-- level of the database underneath it.
--
-- NOT a hint on `croft done`. CROFT-211 considered and refused it — "a
-- per-call nag is not actionable, and trains people to ignore the line" — and
-- CROFT-135's resolution called restating the rule "the third version of the
-- same non-fix". Both still hold, and neither was the thing that was wrong.
--
-- TRANSFORMED, NOT RE-COPIED, and asserted rather than trusted. See 051, and
-- 050 before it: a migration that copies the body out of an older file
-- silently reverts every transformation applied since (048's owner predicates,
-- 050's actor_type). This edits the definition actually installed, matches the
-- exact text 051 left behind, and raises if that text is not there rather
-- than letting `replace` return the input unchanged and reporting success.
-- ===========================================================================

do $migration$
declare
  fn oid;
  definition text;
  updated text;
  old_cte text;
  new_cte text;
  old_key text;
  new_key text;
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'croft_vitals';

  if fn is null then
    raise exception 'croft_vitals is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%closedWithoutTrace%' then
    raise notice 'croft_vitals already counts closes with no trace; nothing to do';
    return;
  end if;

  -- Byte for byte what 051 inserted. If it is not there, something else has
  -- rewritten this function since and guessing at the replacement is how a
  -- migration quietly ships a predicate nobody wrote.
  old_cte :=
    E',\n  closure_stats as (\n'
    '    select count(*) as closed_unclaimed\n'
    '    from own_tasks t, bounds b\n'
    '    where t.resolved_at >= b.window_start\n'
    '      and not exists (\n'
    '        select 1 from task_activity_events e\n'
    '        where e.task_id = t.id and e.event = ''claimed''\n'
    '      )\n'
    '  )';

  new_cte :=
    E',\n  closure_stats as (\n'
    '    -- Closed in the window with nothing recorded, at any point between\n'
    '    -- filing and close, that anyone was on it. See 054: a claim is one\n'
    '    -- way of being visible, not the only one.\n'
    '    select count(*) as closed_without_trace\n'
    '    from own_tasks t, bounds b\n'
    '    where t.resolved_at >= b.window_start\n'
    '      -- Closed by a runtime. A person is documented as never claiming\n'
    '      -- and claim.ts refuses to claim on their behalf, so counting their\n'
    '      -- closes measures the design rather than a lapse. Unknown\n'
    '      -- provenance is read as a runtime, as agent-silent reads it.\n'
    '      and coalesce((\n'
    '        select e.actor_type from task_activity_events e\n'
    '        where e.task_id = t.id\n'
    '          and e.event in (''resolved'', ''resolution_revised'')\n'
    '        order by e.created_at desc limit 1\n'
    '      ), ''agent'') <> ''human''\n'
    '      and not exists (\n'
    '        select 1 from task_activity_events e\n'
    '        where e.task_id = t.id\n'
    '          and e.created_at <= t.resolved_at\n'
    '          and (\n'
    '            e.event in (''claimed'', ''checkpointed'',\n'
    '                        ''git_commit'', ''git_push'', ''run_result'')\n'
    '            -- The move that closes it is not evidence that anyone could\n'
    '            -- see the work: every close writes one.\n'
    '            or (e.event = ''status_changed''\n'
    '                and coalesce(e.data->>''to'', '''') not in (''done'', ''cancelled''))\n'
    '          )\n'
    '      )\n'
    '  )';

  if strpos(definition, old_cte) = 0 then
    raise exception 'croft_vitals: the closure_stats CTE installed by 051 is not in this definition; refusing to guess what to replace';
  end if;

  updated := replace(definition, old_cte, new_cte);

  if updated = definition then
    raise exception 'croft_vitals: the closure_stats CTE was found and not replaced';
  end if;

  old_key := E'''closedUnclaimed'', c.closed_unclaimed';
  new_key := E'''closedWithoutTrace'', c.closed_without_trace';

  if strpos(updated, old_key) = 0 then
    raise exception 'croft_vitals: the closedUnclaimed payload key from 051 is not in this definition';
  end if;

  updated := replace(updated, old_key, new_key);

  -- The count must be gone under its old name and present under the new one,
  -- and the CTE must still be joined into the final select — 051 added that
  -- and this migration must not have cost it.
  if updated like '%closed_unclaimed%'
     or updated not like '%closedWithoutTrace%'
     or updated not like '%closed_without_trace%'
     or updated not like '%closure_stats c;%' then
    raise exception 'croft_vitals: rewrite left the old count behind, or lost the new one';
  end if;

  execute updated;
end
$migration$;

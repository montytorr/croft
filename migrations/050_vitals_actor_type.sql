-- ===========================================================================
-- 050: vitals can tell a person from a runtime
--
-- The warning, seen on our own instance:
--
--   monty.torr@gmail.com has written nothing in 24h, against 97 in the week
--   before. This may simply be an idle runtime; verify it was expected to be
--   active before investigating hooks or keys.
--
-- That is the owner of the instance. The 97 is a week of his own clicks in
-- the web UI. He has no hooks and no keys to investigate.
--
-- Not a legacy multi-user artefact, which was the first guess. It is a live
-- and correct distinction that the check never looked at: `actorLabel` in
-- src/lib/api/actor.ts gives a human their display name unqualified and an
-- agent `<runtime> · <display name>`, and 049 says so outright while
-- backfilling older rows. The four actors on that instance:
--
--   claude-code · monty.torr@gmail.com   recent 208   week 1641
--   openclaw · monty.torr@gmail.com      recent   0   week 1045
--   monty.torr@gmail.com                 recent   0   week   97   <- a person
--   codex · monty.torr@gmail.com         recent   0   week   74
--
-- `agent_stats` selected `e.actor_id as agent` and grouped by it, with no
-- reference to `actor_type` — a column that has existed since 001_initial.
-- So every person who ever touched a task arrived in the list that the
-- agent-silent check reads.
--
-- THE COST IS NOT THE NOISE. openclaw wrote 1045 times in the week and
-- nothing in 24h, and that is exactly what the check exists to surface. It
-- was sitting in the same list as a false positive about a person, and a
-- warning that is wrong half the time is one nobody finishes reading.
--
-- TRANSFORMED, NOT RE-COPIED, and this migration learned that the hard way.
-- The first draft of it copied the whole body out of 036 and changed the one
-- CTE. That reverted croft_vitals to a pre-047 world: the owner predicates
-- 048 had stripped came back, and the integration suite caught it. 048's own
-- header says why, and says it about this exact function:
--
--   "Re-copying hundreds of lines from an older definition would silently
--    revive fixed ranking, pagination or feed bugs. This transforms the
--    definitions actually installed immediately before this migration."
--
-- So this one does the same, and asserts loudly rather than quietly doing
-- nothing if the shape it expects is not there.
-- ===========================================================================

do $migration$
declare
  fn oid;
  definition text;
  updated text;
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'croft_vitals';

  if fn is null then
    raise exception 'croft_vitals is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%actorType%' then
    raise notice 'croft_vitals already carries actorType; nothing to do';
    return;
  end if;

  -- Carried, not filtered on. The panel these rows feed is titled "Who
  -- wrote", and a person who wrote ninety-seven times in a week is a true
  -- answer to that question. It is the agent-silent check that needed to
  -- know the difference, not this list.
  updated := regexp_replace(
    definition,
    '(e\.actor_id[[:space:]]+as agent,)',
    E'\\1\n        e.actor_type                                                 as "actorType",',
    'g'
  );

  -- Grouped by both, so a person and a runtime that somehow shared an
  -- actor_id stay two rows rather than one row of nonsense.
  updated := regexp_replace(
    updated,
    'group by e\.actor_id(?![[:space:]]*,)',
    'group by e.actor_id, e.actor_type',
    'g'
  );

  if updated = definition then
    raise exception 'croft_vitals did not contain the agent_stats shape this migration edits';
  end if;
  if updated not like '%actorType%' or updated not like '%group by e.actor_id, e.actor_type%' then
    raise exception 'croft_vitals rewrite did not produce both changes';
  end if;

  execute updated;
end
$migration$;

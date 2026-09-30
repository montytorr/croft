-- ===========================================================================
-- 051: vitals counts the work nobody said they were doing
--
-- CROFT-135 measured that 36% of closed tasks had never been claimed, shipped
-- auto-claim on note and checkpoint, and that was that. CROFT-146 then
-- narrowed it correctly — a note only HINTS, a checkpoint claims — because
-- annotating is most of what reading a backlog is, and inferring intent from
-- the wrong signal caused the exact failure it was meant to prevent.
--
-- Both decisions stand. The hole between them is `croft done`, which neither
-- claims nor hints. A task filed and finished inside one session has no claim
-- event at any point in its life: it never appears as in progress, never holds
-- a lease, never heartbeats, and nothing counts that it happened. BOTHY-13's
-- entire history, from this month:
--
--   07:48 created   07:59 git_commit   07:59 git_push   07:59 resolved
--
-- Eleven minutes, backlog to done, zero claim events. BOTHY-14 is identical.
--
-- The cost is not tidiness. The board said nobody was working those tasks
-- while they were being worked, so a second agent could have started the same
-- thing; there was no lease and no heartbeat, so a crash mid-work would have
-- left them looking untouched rather than abandoned; and the per-agent figures
-- CROFT-97 went to some trouble to make trustworthy undercount.
--
-- Above all: 36% was measured ONCE, proved the problem, and has had no reader
-- since. Nothing recomputes it, so nobody would know if it went back up.
--
-- This is the shape vitals is for — a number nobody else watches. Not a nag
-- per call, which trains people to skip the line, but a finding when it is a
-- pattern. NOT auto-claim on close: CROFT-146 rejected inferring intent from
-- an ambiguous signal, and closing is at least as ambiguous as annotating —
-- CROFT-148 added `--kind verified` precisely for "I checked someone else's
-- fix".
--
-- Transformed, not re-copied. See 050, and 048 before it.
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

  if definition like '%closedUnclaimed%' then
    raise notice 'croft_vitals already counts closed-unclaimed; nothing to do';
    return;
  end if;

  -- The CTE, inserted immediately before the final select.
  updated := replace(
    definition,
    E'select jsonb_build_object(',
    E',\n  closure_stats as (\n'
    '    select count(*) as closed_unclaimed\n'
    '    from own_tasks t, bounds b\n'
    '    where t.resolved_at >= b.window_start\n'
    '      and not exists (\n'
    '        select 1 from task_activity_events e\n'
    '        where e.task_id = t.id and e.event = ''claimed''\n'
    '      )\n'
    '  )\n'
    'select jsonb_build_object('
  );
  -- `replace` is global; only the final select is preceded by a newline at
  -- column zero, but assert rather than trust it.
  if (length(updated) - length(definition)) <= 0 then
    raise exception 'croft_vitals: the final select was not found';
  end if;

  updated := replace(
    updated,
    E'''held'', t.held',
    E'''held'', t.held, ''closedUnclaimed'', c.closed_unclaimed'
  );

  updated := replace(
    updated,
    E'knowledge_stats k, agent_stats a;',
    E'knowledge_stats k, agent_stats a, closure_stats c;'
  );

  if updated not like '%closedUnclaimed%'
     or updated not like '%closure_stats c;%'
     or updated not like '%closure_stats as (%' then
    raise exception 'croft_vitals: rewrite did not produce all three changes';
  end if;

  execute updated;
end
$migration$;

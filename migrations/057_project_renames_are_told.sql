-- ===========================================================================
-- 057: a project rename says who did it, what it became, and shows in the feed
--
-- Found renaming AC -> HOL and ACC -> HOLC on 2026-09-22 (CROFT-264). Old
-- refs went on resolving, which 031 was for, but nothing said the rename had
-- happened, and the two places that recorded it each held half the story:
--
--   * `project_former_keys` kept the retired key, the project and when — not
--     who retired it, and not what it became. For a project renamed twice,
--     "AC" pointed at the project and said nothing about HOL.
--   * the activity event `project_key_changed` kept the actor and from/to, and
--     `activity_feed` rendered it with an EMPTY title, because its title
--     expression only reads `data.title` and `data.key`. `project_renamed`
--     (the title changing, "A2A comms" -> "Holloway") was blank the same way.
--     Both were recorded faithfully and displayed as nothing.
--
-- TRANSFORMED, NOT RE-COPIED. `project_rename_key` was defined in 031 and
-- rewritten in 047 for the shared workspace; `activity_feed` has been through
-- 019, 028, 029, 034, 041 and 048. Re-copying either from its last file would
-- silently revert whatever happened in between — 050 did exactly that to
-- croft_vitals and brought back owner predicates 048 had removed. So both are
-- read from the catalogue as installed, edited in the one place that matters,
-- and refused loudly if that place is not there. A re-run is a no-op.
-- ===========================================================================

alter table project_former_keys
  add column if not exists retired_by text,
  add column if not exists new_key    text;

-- ---------------------------------------------------------------------------
-- Backfill, only where the answer is actually known.
--
-- The event is the best evidence: it names both keys and the actor, and it is
-- what the rename wrote at the time. The latest one for a key wins, because a
-- key can be retired, reclaimed and retired again, and only the last retirement
-- is the row that exists.
--
-- Without an event (renames from before 040 recorded project events at all),
-- new_key is still derivable from the chain: a project's former keys in the
-- order they were retired, each one followed by the next, and the newest one
-- followed by the live key. retired_by is not derivable, so it stays null
-- rather than being guessed.
--
-- No touch trigger on this table, and the namespace guard fires on key and
-- project_id only, so neither is disturbed by these updates.
-- ---------------------------------------------------------------------------

update project_former_keys f
   set new_key    = coalesce(f.new_key, ev.to_key),
       retired_by = coalesce(f.retired_by, ev.actor_id)
  from (
    select distinct on (e.project_id, e.data->>'from')
           e.project_id, e.data->>'from' as from_key, e.data->>'to' as to_key, e.actor_id
      from task_activity_events e
     where e.event = 'project_key_changed'
       and e.project_id is not null
       and e.data ? 'from'
     order by e.project_id, e.data->>'from', e.created_at desc
  ) ev
 where ev.project_id = f.project_id
   and ev.from_key = f.key
   and (f.new_key is null or f.retired_by is null);

update project_former_keys f
   set new_key = chain.next_key
  from (
    select k.key,
           coalesce(
             lead(k.key) over (partition by k.project_id order by k.retired_at),
             p.key
           ) as next_key
      from project_former_keys k
      join projects p on p.id = k.project_id
  ) chain
 where chain.key = f.key
   and f.new_key is null;

-- ---------------------------------------------------------------------------
-- The rename records who and what, from now on.
--
-- A new trailing parameter with a default, so every existing two-argument call
-- keeps working. That changes the signature, which `create or replace` treats
-- as a second function; the old one is dropped in the same transaction so a
-- two-argument call is never ambiguous between them.
-- ---------------------------------------------------------------------------

do $migration$
declare
  fn oid;
  definition text;
  updated text;
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'project_rename_key'
     and pg_get_function_identity_arguments(p.oid) = 'p_project uuid, p_new_key text';

  if fn is null then
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'project_rename_key'
         and pg_get_function_identity_arguments(p.oid) like '%p_actor%'
    ) then
      raise notice 'project_rename_key already takes p_actor; nothing to do';
      return;
    end if;
    raise exception 'project_rename_key(uuid, text) is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  updated := regexp_replace(
    definition,
    'project_rename_key\(p_project uuid, p_new_key text\)',
    'project_rename_key(p_project uuid, p_new_key text, p_actor text DEFAULT NULL::text)'
  );
  if updated = definition then
    raise exception 'project_rename_key: signature shape not found';
  end if;
  definition := updated;

  updated := regexp_replace(
    definition,
    'insert into project_former_keys \(owner_user_id, key, project_id\)([[:space:]]+)values \(v_owner, v_old, p_project\)',
    'insert into project_former_keys (owner_user_id, key, project_id, retired_by, new_key)\1values (v_owner, v_old, p_project, p_actor, p_new_key)',
    'i'
  );
  if updated = definition then
    raise exception 'project_rename_key: former-key insert shape not found';
  end if;
  definition := updated;

  -- The conflict branch is a re-retirement of a key this project reclaimed
  -- earlier: the row is the new retirement, so all of it is replaced.
  updated := regexp_replace(
    definition,
    '(do update set project_id = excluded\.project_id,[[:space:]]*retired_at = now\(\))',
    '\1, retired_by = excluded.retired_by, new_key = excluded.new_key',
    'i'
  );
  if updated = definition then
    raise exception 'project_rename_key: on-conflict shape not found';
  end if;
  definition := updated;

  drop function project_rename_key(uuid, text);
  execute definition;
end
$migration$;

-- ---------------------------------------------------------------------------
-- The feed titles a rename with what it was and what it became.
--
-- `project_key_changed` and `project_renamed` both carry data.from/data.to;
-- the title reads "AC → HOL" and "A2A comms → Holloway". The project is
-- already carried: project_key and ref fall back to the live key through the
-- event's project_id, which is what a reader links through.
-- ---------------------------------------------------------------------------

do $migration$
declare
  fn oid;
  definition text;
  updated text;
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'activity_feed';

  if fn is null then
    raise exception 'activity_feed is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%project_key_changed%' then
    raise notice 'activity_feed already titles project renames; nothing to do';
    return;
  end if;

  updated := regexp_replace(
    definition,
    'coalesce\(t\.title,[[:space:]]*e\.data->>''title'',[[:space:]]*e\.data->>''key'',[[:space:]]*''''\)[[:space:]]+as title',
    E'coalesce(\n             t.title,\n             case when e.event in (''project_key_changed'', ''project_renamed'')\n                   and e.data ? ''from''\n                  then (e.data->>''from'') || '' → '' || coalesce(e.data->>''to'', ''?'')\n             end,\n             e.data->>''title'', e.data->>''key'', ''''\n           ) as title'
  );
  if updated = definition then
    raise exception 'activity_feed: event title shape not found';
  end if;

  execute updated;
end
$migration$;

-- Replace every current workspace RPC definition in place while preserving its
-- exact signature and all behavior unrelated to tenancy. The functions keep
-- p_owner for N-1 API compatibility, but legacy owner_user_id columns are now
-- attribution metadata rather than authorization boundaries.
--
-- Using pg_get_functiondef here is deliberate: search, activity and vitals have
-- evolved through several migrations. Re-copying hundreds of lines from an
-- older definition would silently revive fixed ranking, pagination or feed
-- bugs. This transforms the definitions actually installed immediately before
-- this migration.
do $migration$
declare
  target record;
  definition text;
  transformed integer := 0;
begin
  for target in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any (array[
         'search_tasks',
         'search_all',
         'activity_feed',
         'list_labels',
         'rename_label',
         'croft_pulse',
         'croft_work_shape',
         'croft_memory_use',
         'croft_vitals'
       ])
  loop
    definition := pg_get_functiondef(target.oid);

    -- `where owner = p_owner and predicate` becomes `where predicate`.
    definition := regexp_replace(
      definition,
      '[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id[[:space:]]*=[[:space:]]*p_owner[[:space:]]+and[[:space:]]+',
      '',
      'g'
    );
    -- A standalone WHERE owner predicate must leave valid SQL behind.
    definition := regexp_replace(
      definition,
      'where[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id[[:space:]]*=[[:space:]]*p_owner',
      'where true',
      'gi'
    );
    -- The label maintenance function has the owner predicate after another
    -- condition, so preserve the conjunction as a harmless true expression.
    definition := regexp_replace(
      definition,
      'and[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id[[:space:]]*=[[:space:]]*p_owner',
      'and true',
      'gi'
    );

    if definition ~ '[a-zA-Z_][a-zA-Z0-9_]*\.owner_user_id[[:space:]]*=[[:space:]]*p_owner' then
      raise exception 'owner predicate remains in function %', target.proname;
    end if;

    execute definition;
    transformed := transformed + 1;
  end loop;

  if transformed <> 9 then
    raise exception 'expected 9 workspace RPCs, found %', transformed;
  end if;
end
$migration$;

-- Activity rows can outlive their task and can describe projects or knowledge,
-- so the pulse must not reach them through an inner task/project join.
create or replace function croft_pulse(p_owner uuid, p_project text default null)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with scoped_tasks as (
    select t.updated_at
      from tasks t
      join projects p on p.id = t.project_id
     where p_project is null or p.key = upper(p_project)
  )
  select concat_ws('|',
    coalesce(max(updated_at)::text, '-') || ':' || count(*)::text,
    case when p_project is not null then '' else (
      select coalesce(max(s.updated_at)::text, '-') || ':' || count(*)::text
        from sessions s
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(k.updated_at)::text, '-') || ':' || count(*)::text
        from knowledge k
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(e.created_at)::text, '-')
        from task_activity_events e
    ) end
  )
  from scoped_tasks;
$$;

revoke all on function croft_pulse from public;

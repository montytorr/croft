-- ===========================================================================
-- 037: one heartbeat that covers every store, not only tasks
--
-- The live-update stream compared a fingerprint of `max(tasks.updated_at)` and
-- `count(tasks)`. That is why five pages refresh themselves and eight do not,
-- and why adding the component to the rest would have been a lie: a session
-- recorded, a fact learned or an activity event written moves nothing in that
-- fingerprint, so the page would hold a subscription that could never fire.
--
-- Two round trips per client every four seconds also became six as soon as the
-- other stores were included, so it is one function instead.
--
-- Project scope deliberately stays tasks-only: a project page shows that
-- project's tasks, and refreshing it because an unrelated session was recorded
-- would be churn without information.
-- ===========================================================================

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
    where p.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
  )
  select concat_ws('|',
    -- Count as well as the newest timestamp: a deletion does not move a max.
    coalesce(max(updated_at)::text, '-') || ':' || count(*)::text,
    case when p_project is not null then '' else (
      select coalesce(max(s.updated_at)::text, '-') || ':' || count(*)::text
      from sessions s where s.owner_user_id = p_owner
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(k.updated_at)::text, '-') || ':' || count(*)::text
      from knowledge k where k.owner_user_id = p_owner
    ) end,
    case when p_project is not null then '' else (
      -- Activity is append-only, so the newest row is enough.
      select coalesce(max(e.created_at)::text, '-')
      from task_activity_events e
      join tasks t on t.id = e.task_id
      join projects p on p.id = t.project_id
      where p.owner_user_id = p_owner
    ) end
  )
  from scoped_tasks;
$$;

revoke all on function croft_pulse from public;

comment on function croft_pulse is
  'One string that changes whenever anything this owner can see changes. Read '
  'by the SSE stream every few seconds, so it must stay index-cheap.';

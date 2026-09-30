-- Text that stops mid-word looks like damage, not a summary.
--
-- The feed clipped notes and comments at exactly 160 characters with `left()`,
-- so a row ended "zero structural-field misma" and the reader could not tell
-- whether the sentence had been truncated or the data was broken.

create or replace function croft_clip(p_text text, p_limit int)
returns text
language sql
immutable
as $$
  select case
    when p_text is null then null
    when length(p_text) <= p_limit then p_text
    else
      -- Greedy up to the last whitespace inside the limit, so a word is never
      -- cut in half. `substring` returns null when there is no whitespace at
      -- all — 160 unbroken characters are not prose, and a hard cut is then
      -- the honest answer.
      rtrim(
        coalesce(
          substring(left(p_text, p_limit) from '^.*\s'),
          left(p_text, p_limit)
        )
      ) || '…'
  end;
$$;

create or replace function activity_feed(
  p_owner   uuid,
  p_before  timestamptz default null,
  p_limit   int default 50,
  p_project text default null,
  p_actor   text default null,
  p_kinds   text[] default null   -- task | note | comment | session | knowledge | event
)
returns table (
  kind         text,
  at           timestamptz,
  actor        text,
  project_key  text,
  ref          text,
  title        text,
  detail       text
)
language sql
stable
security definer
set search_path = public
as $$
  with
  want as (select p_kinds is null as all_kinds, coalesce(p_kinds, '{}'::text[]) as kinds),
  ceiling as (select coalesce(p_before, 'infinity'::timestamptz) as before),

  -- A task appearing. Its later life is covered by the event rows below.
  filed as (
    select 'task'::text as kind, t.created_at as at, t.actor_id as actor,
           p.key as project_key, p.key || '-' || t.number as ref,
           t.title, t.type as detail
    from tasks t
    join projects p on p.id = t.project_id
    cross join want w, ceiling c
    where p.owner_user_id = p_owner and t.created_at < c.before
      and (w.all_kinds or 'task' = any (w.kinds))
  ),

  -- What actually changed, recorded whether or not anyone narrated it.
  events as (
    select 'event'::text as kind, e.created_at as at, e.actor_id as actor,
           p.key as project_key, p.key || '-' || t.number as ref,
           t.title, e.event as detail
    from task_activity_events e
    join tasks t    on t.id = e.task_id
    join projects p on p.id = t.project_id
    cross join want w, ceiling c
    where p.owner_user_id = p_owner and e.created_at < c.before
      and (w.all_kinds or 'event' = any (w.kinds))
  ),

  notes as (
    select 'note'::text as kind, n.created_at as at, n.actor_id as actor,
           p.key as project_key, p.key || '-' || t.number as ref,
           croft_clip(regexp_replace(n.note, '\s+', ' ', 'g'), 160) as title,
           n.kind as detail
    from task_notes n
    join tasks t    on t.id = n.task_id
    join projects p on p.id = t.project_id
    cross join want w, ceiling c
    where p.owner_user_id = p_owner and n.created_at < c.before
      and (w.all_kinds or 'note' = any (w.kinds))
  ),

  comments as (
    select 'comment'::text as kind, c.created_at as at, c.actor_id as actor,
           p.key as project_key, p.key || '-' || t.number as ref,
           croft_clip(regexp_replace(c.content, '\s+', ' ', 'g'), 160) as title,
           c.comment_type as detail
    from task_comments c
    join tasks t    on t.id = c.task_id
    join projects p on p.id = t.project_id
    cross join want w, ceiling cl
    where p.owner_user_id = p_owner and c.created_at < cl.before
      and (w.all_kinds or 'comment' = any (w.kinds))
  ),

  sessions_ as (
    select 'session'::text as kind, coalesce(s.ended_at, s.created_at) as at,
           coalesce(s.agent_id, s.platform_source) as actor,
           p.key as project_key,
           to_char(coalesce(s.ended_at, s.created_at), 'HH24:MI') as ref,
           coalesce(s.request, '(session)') as title,
           s.platform_source as detail
    from sessions s
    left join projects p on p.id = s.project_id
    cross join want w, ceiling c
    where s.owner_user_id = p_owner and coalesce(s.ended_at, s.created_at) < c.before
      and (w.all_kinds or 'session' = any (w.kinds))
  ),

  -- `updated_at` rather than `created_at`: a correction is the event worth
  -- seeing, and correcting knowledge is the behaviour this is meant to reward.
  knowledge_ as (
    select 'knowledge'::text as kind, k.updated_at as at, k.actor_id as actor,
           (select string_agg(pr.key, ',' order by pr.key)
              from knowledge_projects kp join projects pr on pr.id = kp.project_id
             where kp.knowledge_id = k.id) as project_key,
           k.slug as ref, k.title,
           case when k.superseded_by is not null then 'superseded' else 'learned' end as detail
    from knowledge k
    cross join want w, ceiling c
    where k.owner_user_id = p_owner and k.updated_at < c.before
      and (w.all_kinds or 'knowledge' = any (w.kinds))
  ),

  everything as (
    select * from filed     union all
    select * from events    union all
    select * from notes     union all
    select * from comments  union all
    select * from sessions_ union all
    select * from knowledge_
  )

  select e.kind, e.at, e.actor, e.project_key, e.ref, e.title, e.detail
  from everything e
  where (p_project is null or e.project_key = upper(p_project))
    and (p_actor is null or e.actor = p_actor)
  order by e.at desc
  limit p_limit;
$$;

revoke all on function activity_feed from public;

comment on function activity_feed is
  'One timeline across tasks filed, what changed on them, notes, comments, '
  'sessions and knowledge. Keyset-paginated on `at` because the feed grows '
  'from the head and an OFFSET page would drift under it.';

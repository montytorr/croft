-- ===========================================================================
-- 034: the timeline says WHICH commit, and the same commit is recorded once
--
-- Two things about the delivery evidence added in 032.
--
-- The feed projected `e.event` as its detail, which is complete for every
-- other event — `renamed` and `blocked` are wholly described by their names —
-- and empty for these three, where the whole point is the payload. A commit
-- appeared in the timeline as "changed · git commit" against the task title,
-- naming no commit.
--
-- And nothing stopped the same commit being recorded twice. A note is
-- idempotent on its content hash precisely because a hook that times out and
-- retries must not double-write; evidence is written by exactly that kind of
-- caller and had no such protection.
-- ===========================================================================

-- One row per commit per task. Partial, because a run_result has no sha and
-- the same command genuinely can be run twice — re-running the tests after a
-- fix is a different fact, not a duplicate.
create unique index if not exists task_activity_evidence_sha_idx
  on task_activity_events (task_id, event, (data->>'sha'))
  where event in ('git_commit', 'git_push') and data ? 'sha';

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
           t.title,
           -- Delivery evidence carries its own answer, so the feed says what
           -- it was rather than only that it happened. Every other event is
           -- fully described by its name; `git_commit` on its own is the one
           -- row where the interesting part — which commit, which branch,
           -- whether the run passed — sits in the payload and was dropped.
           case e.event
             when 'git_commit' then 'git_commit ' || coalesce(substr(e.data->>'sha', 1, 8), '?')
             when 'git_push'   then 'git_push '   || coalesce(e.data->>'branch', substr(e.data->>'sha', 1, 8), '?')
             when 'run_result' then 'run_result ' || coalesce(e.data->>'status', '?')
             else e.event
           end as detail
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

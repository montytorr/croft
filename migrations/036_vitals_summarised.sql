-- ===========================================================================
-- 036: vitals counts sessions that were actually summarised
--
-- A session is two halves: the files and task refs, read from the transcript,
-- and the prose — what was asked, learned, completed, left — which costs a
-- model call. The hook deliberately keeps the row when the summariser cannot
-- be reached, so as not to lose the deterministic half. That is right, and it
-- means the prose can stop being written without anything failing.
--
-- It did, for the entire life of the feature. `claude -p` as root answers "Not
-- logged in"; the OpenClaw sweep runs as root because the transcripts live
-- under a 0700 home; 42 of 42 OpenClaw sessions were recorded with no prose at
-- all. Every count vitals watched was healthy, because the rows were there.
--
-- Only the session_stats CTE and the payload change. Otherwise 022 verbatim.
-- ===========================================================================

create or replace function croft_vitals(p_owner uuid, p_hours int default 24)
returns jsonb
language sql
stable
as $$
with
  bounds as (
    select
      now() - make_interval(hours => p_hours)     as window_start,
      -- The week before the window, as the thing to compare against. A count
      -- means nothing on its own; "none today, forty last week" means a lot.
      now() - make_interval(hours => p_hours + 168) as baseline_start,
      now() - make_interval(hours => p_hours)     as baseline_end
  ),
  own_tasks as (
    select t.* from tasks t
    join projects p on p.id = t.project_id
    where p.owner_user_id = p_owner
  ),
  session_stats as (
    select
      count(*) filter (where s.created_at >= b.window_start)                      as recent,
      count(*) filter (where s.created_at >= b.window_start
                         and jsonb_typeof(s.files) = 'array'
                         and jsonb_array_length(s.files) > 0)                     as recent_with_files,
      -- The prose half. A session is the files AND what was learned; the
      -- second costs a model call and can stop being written without anything
      -- failing, because the hook keeps the row when it cannot reach one.
      count(*) filter (where s.created_at >= b.window_start
                         and (coalesce(s.learned, '') <> ''
                           or coalesce(s.completed, '') <> ''
                           or coalesce(s.next_steps, '') <> ''))                  as recent_summarised,
      count(*) filter (where s.created_at >= b.baseline_start
                         and s.created_at < b.baseline_end)                       as baseline,
      count(*) filter (where s.created_at >= b.baseline_start
                         and s.created_at < b.baseline_end
                         and jsonb_typeof(s.files) = 'array'
                         and jsonb_array_length(s.files) > 0)                     as baseline_with_files
    from sessions s, bounds b
    where s.owner_user_id = p_owner
  ),
  task_stats as (
    select
      count(*) filter (where t.created_at >= b.window_start)                      as opened,
      count(*) filter (where t.resolved_at >= b.window_start)                     as closed,
      count(*) filter (where t.status = 'doing' and t.claimed_by is null
                         and coalesce(t.heartbeat_at, t.updated_at) < b.window_start) as stalled,
      count(*) filter (where t.claimed_by is not null)                            as held
    from own_tasks t, bounds b
  ),
  release_stats as (
    select count(*) as auto_released
    from task_activity_events e
    join own_tasks t on t.id = e.task_id, bounds b
    where e.event = 'released'
      and e.data->>'reason' = 'reconcile'
      and e.created_at >= b.window_start
  ),
  knowledge_stats as (
    select count(*) as written
    from knowledge k, bounds b
    where k.owner_user_id = p_owner and k.created_at >= b.window_start
  ),
  -- Per agent, because an agent that has gone silent is the single clearest
  -- sign that its wiring broke, and it is invisible in any total.
  agent_stats as (
    select coalesce(jsonb_agg(row_to_json(a)::jsonb order by a.agent), '[]'::jsonb) as agents
    from (
      select
        e.actor_id                                                   as agent,
        count(*) filter (where e.created_at >= b.window_start)        as recent,
        count(*) filter (where e.created_at >= b.baseline_start
                           and e.created_at < b.baseline_end)         as baseline
      from task_activity_events e
      join own_tasks t on t.id = e.task_id, bounds b
      where e.created_at >= b.baseline_start
      group by e.actor_id
    ) a
  )
select jsonb_build_object(
  'windowHours', p_hours,
  'sessions', jsonb_build_object(
    'recent', s.recent,
    'recentWithFiles', s.recent_with_files,
    'recentSummarised', s.recent_summarised,
    'baseline', s.baseline,
    'baselineWithFiles', s.baseline_with_files
  ),
  'tasks', jsonb_build_object(
    'opened', t.opened, 'closed', t.closed, 'stalled', t.stalled, 'held', t.held
  ),
  'autoReleased', r.auto_released,
  'knowledgeWritten', k.written,
  'agents', a.agents
)
from session_stats s, task_stats t, release_stats r, knowledge_stats k, agent_stats a;
$$;

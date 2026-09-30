-- ===========================================================================
-- 038: `check --project` scopes knowledge too
--
-- search_all applies p_project on three of its four branches. Tasks, notes and
-- sessions filter on it; knowledge never did. So `croft check "x" --project BB`
-- returned knowledge belonging to HM and TD, and the caller believed the answer
-- was scoped — which is worse than an unsupported filter, because absence then
-- reads as "this is new".
--
-- The rule is not simply "same project". A fact with no project and no entity
-- is true everywhere and must still appear; that is what global means, and
-- dropping it would trade a noisy answer for a missing one. A fact scoped to an
-- entity appears when the named project belongs to that entity, which is the
-- reason entities exist at all.
--
-- Generated from 033, not 020: 033 is the current definition and carries the
-- demotion that makes a correction outrank the claim it corrects. Regenerating
-- from the older file would have reverted that silently, which is the mistake
-- this comment exists to stop the next person repeating.
-- ===========================================================================

create or replace function search_all(
  p_owner       uuid,
  p_query       text,
  p_terms       text[] default null,
  p_project     text default null,
  p_kinds       text[] default null,
  p_limit       int  default 20,
  p_min_precise int  default 3
)
returns table (
  kind         text,
  id           uuid,
  ref          text,
  title        text,
  subtitle     text,
  project_key  text,
  status       text,
  type         text,
  answered     boolean,
  updated_at   timestamptz,
  body_bytes   int,
  rank         real,
  widened      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with
  q as (
    select
      websearch_to_tsquery('english', p_query) as precise,
      case
        when p_terms is not null and cardinality(p_terms) >= 2
        then websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))
      end as wide
  ),
  want as (
    select p_kinds is null as all_kinds, coalesce(p_kinds, '{}'::text[]) as kinds
  ),

  task_rows as (
    select 'task'::text as kind, t.id,
           p.key || '-' || t.number as ref,
           t.title,
           nullif(concat_ws(' · ', t.priority, nullif(array_to_string(t.labels, ', '), '')), '') as subtitle,
           p.key as project_key, t.status, t.type,
           t.has_resolution as answered, t.updated_at,
           (coalesce(length(t.description), 0) + coalesce(length(t.resolution), 0))::int as body_bytes,
           t.search_vector as vec
    from tasks t
    join projects p on p.id = t.project_id
    cross join want w
    where p.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'task' = any (w.kinds))
  ),

  note_rows as (
    select 'note'::text as kind, n.id,
           p.key || '-' || t.number as ref,
           left(regexp_replace(n.note, '\s+', ' ', 'g'), 120) as title,
           n.kind as subtitle,
           p.key as project_key, t.status, t.type,
           (n.kind in ('finding', 'decision')) as answered,
           n.created_at as updated_at,
           coalesce(length(n.note), 0)::int as body_bytes,
           to_tsvector('english'::regconfig, coalesce(n.note, '')) as vec
    from task_notes n
    join tasks t    on t.id = n.task_id
    join projects p on p.id = t.project_id
    cross join want w
    where p.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'note' = any (w.kinds))
  ),

  knowledge_rows as (
    select 'knowledge'::text as kind, k.id,
           k.slug as ref,
           k.title,
           nullif(array_to_string(k.labels, ', '), '') as subtitle,
           -- Projects are narrower, so they win; entities only when there are
           -- none. Reporting neither is what made an entity-scoped fact look
           -- global to every caller.
           coalesce(
             (select string_agg(pr.key, ',' order by pr.key)
                from knowledge_projects kp
                join projects pr on pr.id = kp.project_id
               where kp.knowledge_id = k.id),
             (select string_agg(e.key, ',' order by e.key)
                from knowledge_entities ke
                join entities e on e.id = ke.entity_id
               where ke.knowledge_id = k.id)
           ) as project_key,
           case when k.superseded_by is not null then 'superseded' else 'current' end as status,
           'knowledge'::text as type,
           (k.verified_at is not null) as answered,
           k.updated_at,
           coalesce(length(k.body), 0)::int as body_bytes,
           k.search_vector as vec
    from knowledge k
    cross join want w
    where k.owner_user_id = p_owner
      and (w.all_kinds or 'knowledge' = any (w.kinds))
      -- Scope, which this branch alone never applied. Tasks, notes and
      -- sessions all filter on p_project; knowledge did not, so `check
      -- --project BB` returned facts belonging to HM and TD and the caller
      -- believed the answer was scoped.
      --
      -- A fact with no project and no entity is true everywhere and must
      -- still appear — that is what global means, and dropping it would turn
      -- a noisy answer into a missing one. A fact scoped to an ENTITY appears
      -- when the named project belongs to that entity, which is the whole
      -- reason entities exist.
      and (
        p_project is null
        or not exists (select 1 from knowledge_projects kp where kp.knowledge_id = k.id)
           and not exists (select 1 from knowledge_entities ke where ke.knowledge_id = k.id)
        or exists (
          select 1 from knowledge_projects kp
          join projects pr on pr.id = kp.project_id
          where kp.knowledge_id = k.id and pr.key = upper(p_project)
        )
        or exists (
          select 1 from knowledge_entities ke
          join project_entities ep on ep.entity_id = ke.entity_id
          join projects pr on pr.id = ep.project_id
          where ke.knowledge_id = k.id and pr.key = upper(p_project)
        )
      )
  ),

  session_rows as (
    select 'session'::text as kind, s.id,
           to_char(coalesce(s.ended_at, s.created_at), 'YYYY-MM-DD') as ref,
           coalesce(s.request, s.completed, '(session)') as title,
           nullif(concat_ws(' · ', s.platform_source, s.cwd), '') as subtitle,
           p.key as project_key,
           s.platform_source as status,
           'session'::text as type,
           (s.next_steps is not null) as answered,
           coalesce(s.ended_at, s.created_at) as updated_at,
           (coalesce(length(s.learned), 0) + coalesce(length(s.completed), 0)
            + coalesce(length(s.next_steps), 0))::int as body_bytes,
           s.search_vector as vec
    from sessions s
    left join projects p on p.id = s.project_id
    cross join want w
    where s.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'session' = any (w.kinds))
  ),

  candidates as (
    select * from task_rows      union all
    select * from note_rows      union all
    select * from knowledge_rows union all
    select * from session_rows
  ),

  precise as (
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, q.precise) as rank, false as widened
    from candidates c, q
    where c.vec @@ q.precise
    order by ts_rank(c.vec, q.precise) desc
    limit p_limit
  ),

  wide as (
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, q.wide) as rank, true as widened
    from candidates c, q
    where q.wide is not null
      and (select count(*) from precise) < p_min_precise
      and c.vec @@ q.wide
      and c.id not in (select precise.id from precise)
    order by ts_rank(c.vec, q.wide) desc
    limit p_limit * 2
  )

  select * from (select * from precise union all select * from wide) hits
  order by
    hits.widened asc,
    -- A correction beats the claim it corrects.
    --
    -- Superseded knowledge was marked and nothing more, so a stale entry whose
    -- wording happened to match the query better still came back above the
    -- entry that replaced it — the schema comment promised "ranked below" and
    -- the ordering never consulted the column.
    --
    -- A demotion rather than a hard sink: sorting every superseded row beneath
    -- every current one would bury the only relevant answer under ten
    -- irrelevant tasks, and "findable but marked" is the whole point of
    -- keeping it. 0.4 puts it behind anything comparable while leaving it
    -- above rows that barely match at all.
    (hits.rank * case when hits.status = 'superseded' then 0.4 else 1 end)::real desc,
    hits.answered desc,
    case hits.kind when 'task' then 0 when 'knowledge' then 1
                   when 'note' then 2 else 3 end,
    hits.updated_at desc
  limit p_limit;
$$;

revoke all on function search_all from public;

-- The comment this migration was written to make true. Stated as what the
-- ordering actually does, rather than as an intention: "ranked below" read as
-- an absolute, and the demotion is relative to comparable hits.
comment on column knowledge.superseded_by is
  'Points at what replaced this. Superseded rows stay findable and are marked, '
  'and their search rank is demoted so the correction outranks the claim it '
  'corrects wherever both match.';

-- ===========================================================================
-- 072: the memory stores go
--
-- Croft is a lab board now (070). Knowledge, sessions, the file index,
-- entities, recall and search telemetry and the vitals report were Cairn's
-- memory half; their pages, CLI verbs and API routes are gone, so their
-- tables and the SQL that read them go too. Agent memory lives in Cairn.
--
-- Order matters, because a SQL-language function body is not a dependency
-- Postgres tracks: the functions that stay (the unified search, the activity
-- feed and the live-update pulse) are redefined without their memory arms
-- FIRST, and only then are the tables dropped. Nothing is dropped with
-- CASCADE — if something unexpected still depends on one of these, this
-- migration fails rather than taking it along silently.
--
-- Kept on purpose:
--   * task_activity_events rows about knowledge (tombstones, `learned`, ...)
--     and the event check constraint that allows them: they are history, and
--     the feed still renders them by the slug they carry.
--   * touch_updated_at's `croft.keep_updated_at` escape hatch: harmless, and
--     redefining a trigger function every table uses is not worth the risk.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- search_all: tasks, notes and subjects. Same signature and result shape, so
-- `create or replace` keeps its grants. The superseded demotion went with
-- knowledge, the only kind that could be superseded.
-- ---------------------------------------------------------------------------
create or replace function search_all(
  p_owner       uuid,
  p_query       text,
  p_terms       text[] default null,
  p_project     text default null,
  p_kinds       text[] default null,
  p_limit       int default 20,
  p_min_precise int default 3
)
returns table (
  kind        text,
  id          uuid,
  ref         text,
  title       text,
  subtitle    text,
  project_key text,
  status      text,
  type        text,
  answered    boolean,
  updated_at  timestamptz,
  body_bytes  int,
  rank        real,
  widened     boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with
  -- 055: both arms run and the precise one asks for N of M terms.
  terms as (
    -- The distinctive terms as the text-search configuration will actually
    -- see them. A stopword term can never match, so it must not count
    -- towards the threshold.
    select plainto_tsquery('english', term) as tq
      from unnest(coalesce(p_terms, '{}'::text[])) as term
     where numnode(plainto_tsquery('english', term)) > 0
  ),

  q as (
    select
      websearch_to_tsquery('english', p_query) as precise,
      -- nullif: a query whose every distinctive term is a stopword produces an
      -- EMPTY tsquery rather than a null one, and would lose the fallback.
      nullif(case
        when p_terms is not null and cardinality(p_terms) >= 2
        then websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))
      end, ''::tsquery) as wide,
      -- N of M. Half the live terms, and never fewer than two.
      greatest(2, ceil((select count(*) from terms) / 2.0))::int as threshold
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
    where (p_project is null or p.key = upper(p_project))
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
    where (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'note' = any (w.kinds))
  ),

  -- 070: subjects. No project, so a project-scoped search leaves them out.
  -- The stage name is the status; a recorded conclusion is the answer.
  subject_rows as (
    select 'subject'::text as kind, s.id,
           'S-' || s.number as ref,
           s.title,
           nullif(left(regexp_replace(coalesce(s.conclusion, ''), '\s+', ' ', 'g'), 120), '') as subtitle,
           null::text as project_key,
           st.name as status,
           'subject'::text as type,
           (s.conclusion is not null) as answered,
           s.updated_at,
           (coalesce(length(s.body), 0) + coalesce(length(s.conclusion), 0))::int as body_bytes,
           s.search_vector as vec
    from subjects s
    join subject_stages st on st.id = s.stage_id
    cross join want w
    where p_project is null
      and (w.all_kinds or 'subject' = any (w.kinds))
  ),

  candidates as (
    select * from task_rows    union all
    select * from note_rows    union all
    select * from subject_rows
  ),

  precise as (
    -- At least half of the distinctive terms, counted per row.
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, coalesce(q.wide, q.precise), 1|32) as rank, false as widened
    from candidates c, q
    where case
            -- One distinctive term or none: no OR query to count coverage
            -- against, so the whole question stays the test.
            when q.wide is null then c.vec @@ q.precise
            else c.vec @@ q.wide
                 and (select count(*) from terms t where c.vec @@ t.tq) >= q.threshold
          end
    order by ts_rank(c.vec, coalesce(q.wide, q.precise), 1|32) desc
    -- A head, not a block: p_min_precise is the size of the confident head.
    limit (select case when q.wide is null then p_limit
                       else least(p_limit, greatest(p_min_precise, 1)) end from q)
  ),

  wide as (
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, q.wide, 1|32) as rank, true as widened
    from candidates c, q
    where q.wide is not null
      and c.vec @@ q.wide
      and c.id not in (select precise.id from precise)
    order by ts_rank(c.vec, q.wide, 1|32) desc
    limit p_limit * 2
  )

  select * from (select * from precise union all select * from wide) hits
  order by
    hits.widened asc,
    hits.rank desc,
    hits.answered desc,
    case hits.kind when 'task' then 0 when 'note' then 1 else 2 end,
    hits.updated_at desc
  limit p_limit;
$$;

comment on function search_all(uuid, text, text[], text, text[], int, int) is
  'Prior-work retrieval over tasks, notes and subjects. Both arms always run and are '
  'merged: the precise arm returns rows carrying at least half the distinctive terms, '
  'the wide arm everything matching any of them, and a row found by both appears once, '
  'in the precise head. p_min_precise caps how many precise rows lead the answer.';

-- ---------------------------------------------------------------------------
-- activity_feed: tasks filed, events, notes and comments. The body is the one
-- 048 and 057 left installed, minus the session and knowledge arms.
-- ---------------------------------------------------------------------------
create or replace function activity_feed(
  p_owner   uuid,
  p_before  timestamptz default null,
  p_limit   int default 50,
  p_project text default null,
  p_actor   text default null,
  p_kinds   text[] default null   -- task | note | comment | event
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
    where t.created_at < c.before
      and (w.all_kinds or 'task' = any (w.kinds))
  ),

  -- What actually changed, recorded whether or not anyone narrated it.
  events as (
    select 'event'::text as kind, e.created_at as at, e.actor_id as actor,
           p.key as project_key,
           -- The ref, or what it was called before it stopped existing. A
           -- tombstone keeps its ref in `data` because the row it names is
           -- gone; events about knowledge, from before 072, carry a slug.
           coalesce(
             case when t.id is not null then p.key || '-' || t.number end,
             e.data->>'ref',
             p.key,
             e.data->>'slug'
           ) as ref,
           coalesce(
             t.title,
             case when e.event in ('project_key_changed', 'project_renamed')
                   and e.data ? 'from'
                  then (e.data->>'from') || ' → ' || coalesce(e.data->>'to', '?')
             end,
             e.data->>'title', e.data->>'key', ''
           ) as title,
           -- Delivery evidence carries its own answer, so the feed says what
           -- it was rather than only that it happened.
           case e.event
             when 'git_commit' then 'git_commit ' || coalesce(substr(e.data->>'sha', 1, 8), '?')
             when 'git_push'   then 'git_push '   || coalesce(e.data->>'branch', substr(e.data->>'sha', 1, 8), '?')
             when 'run_result' then 'run_result ' || coalesce(e.data->>'status', '?')
             else e.event
           end as detail
    from task_activity_events e
    -- LEFT, all of it: an event outlives its task, and an event about a
    -- project has no task at all.
    left join tasks t    on t.id = e.task_id
    left join projects p on p.id = coalesce(e.project_id, t.project_id)
    cross join want w, ceiling c
    where e.created_at < c.before
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
    where n.created_at < c.before
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
    where c.created_at < cl.before
      and (w.all_kinds or 'comment' = any (w.kinds))
  ),

  everything as (
    select * from filed    union all
    select * from events   union all
    select * from notes    union all
    select * from comments
  )

  select e.kind, e.at, e.actor, e.project_key, e.ref, e.title, e.detail
  from everything e
  where (p_project is null or e.project_key = upper(p_project))
    and (p_actor is null or e.actor = p_actor)
  order by e.at desc
  limit p_limit;
$$;

comment on function activity_feed is
  'One timeline across tasks filed, what changed on them, notes and comments. '
  'Keyset-paginated on `at` because the feed grows from the head and an OFFSET page '
  'would drift under it.';

-- ---------------------------------------------------------------------------
-- croft_pulse: the live-update fingerprint, without sessions and knowledge.
-- ---------------------------------------------------------------------------
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
      select coalesce(max(e.created_at)::text, '-')
        from task_activity_events e
    ) end,
    -- 071: the lab. Subjects move on every edit, note and tag change.
    case when p_project is not null then '' else (
      select coalesce(max(su.updated_at)::text, '-') || ':' || count(*)::text
        from subjects su
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(n.created_at)::text, '-') || ':' || count(*)::text
        from subject_notes n
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(st.updated_at)::text, '-') || ':' || count(*)::text
        from subject_stages st
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(tg.updated_at)::text, '-') || ':' || count(*)::text
        from tags tg
    ) end,
    case when p_project is not null then '' else (
      select count(*)::text
        from subject_tags x
    ) end
  )
  from scoped_tasks;
$$;

comment on function croft_pulse is
  'One string that changes whenever anything visible changes: tasks, activity, and the '
  'lab (subjects, their notes and tags, stages, tags). Read by the SSE stream every few '
  'seconds, so it must stay index-cheap.';

-- ---------------------------------------------------------------------------
-- The tables. Children before parents; their triggers go with them.
-- ---------------------------------------------------------------------------
drop table if exists file_touches;
drop table if exists knowledge_recall_state;
drop table if exists knowledge_files;
drop table if exists knowledge_revisions;
drop table if exists knowledge_entities;
drop table if exists knowledge_projects;
drop table if exists project_entities;
drop table if exists knowledge_reads;
drop table if exists search_events;
drop table if exists knowledge;
drop table if exists entities;
drop table if exists sessions;

-- ---------------------------------------------------------------------------
-- The functions only they, the vitals report or the session recorder used.
-- ---------------------------------------------------------------------------
drop function if exists knowledge_files_sync();
drop function if exists knowledge_mark_recalled(uuid[], timestamptz);
drop function if exists knowledge_normalise_path(text);
drop function if exists knowledge_paths_in(text);
drop function if exists knowledge_reads_tag_sweep();
drop function if exists knowledge_recall_counts(timestamptz, uuid[]);
drop function if exists knowledge_recall_state_backfill();
drop function if exists knowledge_touch_recalled_from_read();
drop function if exists knowledge_touch_recalled_from_search();
drop function if exists guard_session_no_reopen();

drop function if exists croft_vitals(uuid, int);
drop function if exists croft_vitals_signals(uuid, int);
drop function if exists croft_work_shape(uuid, int);
drop function if exists croft_memory_use(uuid, int);
drop function if exists session_host(text);
drop function if exists session_is_summariser(text);
drop function if exists task_genuine_activity_at(uuid);
drop function if exists checkpoint_is_untouched(text);
drop function if exists checkpoint_is_automatic(text);

drop function if exists auto_checkpoint_task_atomic(
  uuid, uuid, text, text, bigint, bigint, text, text, timestamptz, jsonb
);

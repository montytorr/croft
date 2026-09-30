-- ===========================================================================
-- 061: how often each fact is actually recalled (CROFT-270)
--
-- 053 started recording which entries a search returned (`returned_slugs`)
-- and every direct read by slug (`knowledge_reads`). Both are summed into
-- totals by croft_memory_use, and nothing ever read them per entry — so the
-- question that finds dead or badly titled facts, "which of these has nobody
-- been given in a month", was answerable from data already on disk and asked
-- by nothing.
--
-- What is counted, and what is not, because a count is only as honest as its
-- denominator:
--   returned  a check/know search listed the entry (search_events)
--   read      the entry was fetched by name — CLI, MCP or browser
--             (knowledge_reads, hits only; a miss names no entry)
-- NOT counted: the session briefing's knowledge list and `croft recall`. Neither
-- records what it showed, so an entry the briefing surfaces daily can read as
-- unused here. That is said wherever the number is shown.
--
-- Slugs are matched as the store spells them: a read of `a_b` resolved to
-- `a-b`, so it is normalised the same way getKnowledge normalises it.
-- ===========================================================================

create or replace function knowledge_recall_counts(p_since timestamptz, p_ids uuid[] default null)
returns table (
  knowledge_id    uuid,
  returned        integer,
  read            integer,
  last_recalled   timestamptz
)
language sql
stable
set search_path = public
as $$
  with wanted as (
    select k.id, k.slug from knowledge k
     where p_ids is null or k.id = any (p_ids)
  ),
  returned as (
    select w.id, count(*)::int as n, max(e.created_at) as last_at
      from search_events e
      cross join lateral unnest(e.returned_slugs) as s(slug)
      join wanted w on w.slug = s.slug
     where e.created_at >= p_since
     group by w.id
  ),
  reads as (
    select w.id, count(*)::int as n, max(r.created_at) as last_at
      from knowledge_reads r
      join wanted w on w.slug = replace(lower(btrim(r.slug)), '_', '-')
     where r.hit and r.created_at >= p_since
     group by w.id
  )
  select w.id,
         coalesce(rt.n, 0),
         coalesce(rd.n, 0),
         greatest(rt.last_at, rd.last_at)
    from wanted w
    left join returned rt on rt.id = w.id
    left join reads rd on rd.id = w.id
$$;

comment on function knowledge_recall_counts(timestamptz, uuid[]) is
  'Per entry since p_since: how many searches returned it, how many direct reads fetched it, and when it was last recalled either way. The session briefing and croft recall are not counted — they record nothing.';

create index if not exists search_events_created_idx on search_events (created_at desc);
create index if not exists knowledge_reads_created_idx on knowledge_reads (created_at desc) where hit;

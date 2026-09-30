-- ===========================================================================
-- 062: remember when each fact was last recalled, instead of recounting it
--
-- `know --unused` ranks the unused set by when each entry was last recalled
-- EVER, never-recalled first. Computed from 061's knowledge_recall_counts with
-- p_since = '-infinity', that aggregates every search_events row (unnesting
-- returned_slugs) and every knowledge_reads hit on each request, however small
-- the limit: the work grows with all recorded history, not with the answer.
--
-- The one number the ranking needs is kept instead, in its OWN table:
--   knowledge_recall_state(knowledge_id, last_recalled_at)
-- maintained by two insert triggers on the tables 053 already writes, and
-- backfilled once below.
--
-- Not a column on knowledge. Any UPDATE of a knowledge row fires
-- knowledge_touch (013), which sets updated_at = now(): every search would
-- have re-stamped the facts it returned as freshly edited, reordered the
-- updated_at-sorted lists, put fabricated edits in the activity feed (041),
-- and invalidated the knowledge graph cache. It would also have rewritten the
-- whole row, body included, on every recall. Recall is metadata about reading
-- a fact; it must never look like writing one.
--
-- Same semantics as knowledge_recall_counts, so the two cannot disagree: a
-- returned slug matches knowledge.slug exactly; a read slug is normalised the
-- way getKnowledge normalises it; misses name no entry and do not count.
-- The session briefing and `croft recall` still record nothing, so they still
-- do not count. The timestamp only ever moves forward.
-- ===========================================================================

create table if not exists knowledge_recall_state (
  knowledge_id      uuid primary key references knowledge(id) on delete cascade,
  last_recalled_at  timestamptz not null
);

comment on table knowledge_recall_state is
  'When each knowledge entry was last recalled (a search returned it or a direct read hit it). No row: never recalled. Kept apart from knowledge so recall never fires knowledge''s update triggers.';

create index if not exists knowledge_recall_state_last_idx
  on knowledge_recall_state (last_recalled_at, knowledge_id);

-- Candidates for the never-recalled half of the ranking, oldest first.
create index if not exists knowledge_current_created_idx
  on knowledge (created_at, id)
  where superseded_by is null;

create or replace function knowledge_mark_recalled(p_ids uuid[], p_at timestamptz) returns void
language sql
set search_path = public
as $$
  insert into knowledge_recall_state as s (knowledge_id, last_recalled_at)
  select id, p_at from unnest(p_ids) as id
  on conflict (knowledge_id) do update
     set last_recalled_at = excluded.last_recalled_at
   where s.last_recalled_at < excluded.last_recalled_at
$$;

create or replace function knowledge_touch_recalled_from_search() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.returned_slugs is not null and cardinality(new.returned_slugs) > 0 then
    perform knowledge_mark_recalled(
      array(select k.id from knowledge k where k.slug = any (new.returned_slugs)),
      new.created_at);
  end if;
  return null;
end;
$$;

create or replace function knowledge_touch_recalled_from_read() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.hit then
    perform knowledge_mark_recalled(
      array(select k.id from knowledge k where k.slug = replace(lower(btrim(new.slug)), '_', '-')),
      new.created_at);
  end if;
  return null;
end;
$$;

drop trigger if exists knowledge_touch_recalled on search_events;
create trigger knowledge_touch_recalled
  after insert on search_events
  for each row execute function knowledge_touch_recalled_from_search();

drop trigger if exists knowledge_touch_recalled on knowledge_reads;
create trigger knowledge_touch_recalled
  after insert on knowledge_reads
  for each row execute function knowledge_touch_recalled_from_read();

-- One pass over history. A function so the integration suite can prove what
-- it does to knowledge (nothing) rather than trusting it. Rerunnable: it only
-- moves timestamps forward.
create or replace function knowledge_recall_state_backfill() returns void
language sql
set search_path = public
as $$
  insert into knowledge_recall_state as s (knowledge_id, last_recalled_at)
  select c.knowledge_id, c.last_recalled
    from knowledge_recall_counts('-infinity'::timestamptz) c
   where c.last_recalled is not null
  on conflict (knowledge_id) do update
     set last_recalled_at = excluded.last_recalled_at
   where s.last_recalled_at < excluded.last_recalled_at
$$;

select knowledge_recall_state_backfill();

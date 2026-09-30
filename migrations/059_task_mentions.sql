-- ===========================================================================
-- 059: a task knows where else it was named (CROFT-267)
--
-- Agents cross-reference constantly — "same cause as HERMES-92", "do NOT read
-- this closure as permission for BB-333" — and the reference only ever pointed
-- one way. BB-343's finding named BB-333 and said its decision must not be
-- generalised to BB-333's case; `croft show BB-333` said nothing about it, so
-- whoever picked BB-333 up would meet the conflict only by already knowing.
--
-- Nothing new is asked of anyone. The refs are already written; this indexes
-- them and reads them backwards. It is deliberately not similarity: a mention
-- is a thing somebody wrote, so there are no false positives to learn to
-- ignore — which is what sank automatic contradiction detection elsewhere.
--
-- Filled by triggers rather than by the API, for the same reason the search
-- vector is a generated column: notes, comments, descriptions and resolutions
-- are written from more places than one route, and an index that misses one
-- path is an index nobody can trust. A ref is resolved when it is written,
-- through current keys and retired ones alike (CROFT-264), so `AC-113` in an
-- old note points at HOL-113.
--
-- The shape `KEY-N` also matches UTF-8, HTTP-404 and SHA-256. Only refs that
-- resolve to a task are kept, which is the same rule the markdown linkifier
-- applies by requiring a real project key.
-- ===========================================================================

create table if not exists task_mentions (
  id              uuid primary key default gen_random_uuid(),
  target_task_id  uuid not null references tasks(id) on delete cascade,
  source_task_id  uuid not null references tasks(id) on delete cascade,
  source          text not null check (source in ('note', 'comment', 'description', 'resolution')),
  note_id         uuid references task_notes(id) on delete cascade,
  comment_id      uuid references task_comments(id) on delete cascade,
  -- As written, so a mention through a retired key can say so.
  ref_as_written  text not null,
  created_at      timestamptz not null default now(),

  constraint task_mentions_not_self check (source_task_id <> target_task_id),
  constraint task_mentions_source_row check (
    (source = 'note' and note_id is not null and comment_id is null) or
    (source = 'comment' and comment_id is not null and note_id is null) or
    (source in ('description', 'resolution') and note_id is null and comment_id is null)
  )
);

create unique index if not exists task_mentions_unique_idx
  on task_mentions (source, coalesce(note_id, comment_id, source_task_id), target_task_id);
create index if not exists task_mentions_target_idx
  on task_mentions (target_task_id, created_at desc);
create index if not exists task_mentions_source_task_idx
  on task_mentions (source_task_id);

comment on table task_mentions is
  'Task refs written in notes, comments, descriptions and resolutions, resolved to the task they name. Read backwards: where else was this task mentioned.';

-- ---------------------------------------------------------------------------
-- The one place a piece of text becomes mentions. Replaces whatever that text
-- mentioned before, so an edited description stops claiming a ref it dropped.
-- ---------------------------------------------------------------------------

create or replace function task_mentions_refresh(
  p_source text,
  p_source_task uuid,
  p_note uuid,
  p_comment uuid,
  p_text text,
  p_at timestamptz
) returns void
language plpgsql
set search_path = public
as $$
begin
  delete from task_mentions m
   where m.source = p_source
     and m.source_task_id = p_source_task
     and m.note_id is not distinct from p_note
     and m.comment_id is not distinct from p_comment;

  if p_text is null or p_text !~ '[A-Z][A-Z0-9]{1,9}-[0-9]' then
    return;
  end if;

  insert into task_mentions
    (target_task_id, source_task_id, source, note_id, comment_id, ref_as_written, created_at)
  select distinct on (t.id)
         t.id, p_source_task, p_source, p_note, p_comment, r.written, coalesce(p_at, now())
    from (
      select m[1] as key, m[2]::int as number, m[1] || '-' || m[2] as written
        from regexp_matches(p_text, '\m([A-Z][A-Z0-9]{1,9})-([0-9]{1,6})\M', 'g') as m
    ) r
    join lateral (
      select p.id from projects p where p.key = r.key
      union
      select f.project_id from project_former_keys f where f.key = r.key
    ) pr on true
    join tasks t on t.project_id = pr.id and t.number = r.number
   where t.id <> p_source_task
   order by t.id, r.written
  on conflict do nothing;
end
$$;

create or replace function task_mentions_from_note() returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform task_mentions_refresh('note', new.task_id, new.id, null, new.note, new.created_at);
  return null;
end
$$;

create or replace function task_mentions_from_comment() returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform task_mentions_refresh('comment', new.task_id, null, new.id, new.content, new.created_at);
  return null;
end
$$;

create or replace function task_mentions_from_task() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.description is distinct from old.description then
    perform task_mentions_refresh('description', new.id, null, null, new.description, new.created_at);
  end if;
  if tg_op = 'INSERT' or new.resolution is distinct from old.resolution then
    perform task_mentions_refresh('resolution', new.id, null, null, new.resolution,
                                  coalesce(new.resolved_at, new.updated_at));
  end if;
  return null;
end
$$;

drop trigger if exists task_mentions_note on task_notes;
create trigger task_mentions_note
  after insert or update of note on task_notes
  for each row execute function task_mentions_from_note();

drop trigger if exists task_mentions_comment on task_comments;
create trigger task_mentions_comment
  after insert or update of content on task_comments
  for each row execute function task_mentions_from_comment();

drop trigger if exists task_mentions_task on tasks;
create trigger task_mentions_task
  after insert or update of description, resolution on tasks
  for each row execute function task_mentions_from_task();

-- ---------------------------------------------------------------------------
-- Everything already written. Through the same function, so the backfill and
-- the triggers cannot disagree about what counts as a mention.
-- ---------------------------------------------------------------------------

select task_mentions_refresh('note', n.task_id, n.id, null, n.note, n.created_at)
  from task_notes n
 where n.note ~ '[A-Z][A-Z0-9]{1,9}-[0-9]';

select task_mentions_refresh('comment', c.task_id, null, c.id, c.content, c.created_at)
  from task_comments c
 where c.content ~ '[A-Z][A-Z0-9]{1,9}-[0-9]';

select task_mentions_refresh('description', t.id, null, null, t.description, t.created_at)
  from tasks t
 where t.description ~ '[A-Z][A-Z0-9]{1,9}-[0-9]';

select task_mentions_refresh('resolution', t.id, null, null, t.resolution, coalesce(t.resolved_at, t.updated_at))
  from tasks t
 where t.resolution ~ '[A-Z][A-Z0-9]{1,9}-[0-9]';

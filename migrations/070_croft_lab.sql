-- ===========================================================================
-- 070: the lab — subjects on a board of stages, with tags, a work log, todos
--
-- Croft stops being a task tracker with memory and becomes a lab board. The
-- unit of work is a SUBJECT: a technology to explore, a proof of concept, an
-- idea to build. It moves through STAGES an administrator curates, carries a
-- write-up anyone can edit, an append-only work log, curated TAGS, an owner,
-- and — once it lands in a completed or dropped stage — a CONCLUSION, because
-- a subject closed without saying what was learned is exactly the waste the
-- lab exists to prevent.
--
-- Todos are not a new table. They are the tasks this codebase already knows
-- how to claim, note, checkpoint and close, living in one system project
-- keyed `T` and pointed at their subject by `tasks.subject_id`. Reusing them
-- keeps every agent verb working on `T-41` unchanged.
--
-- One instance is one working group, so nothing here carries a tenant column.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Project keys may be a single letter.
--
-- The todo project is keyed `T`, and the single letter is deliberate: Cairn's
-- session recorder picks refs out of transcripts with [A-Z][A-Z0-9]{1,9}-\d+,
-- so `T-41` and `S-12` can never be mistaken there for Cairn tasks. The retired
-- key table follows, or renaming `T` could not record what it used to be.
-- ---------------------------------------------------------------------------
alter table projects drop constraint if exists projects_key_format;
alter table projects
  add constraint projects_key_format check (key ~ '^[A-Z][A-Z0-9]{0,9}$');

alter table project_former_keys drop constraint if exists project_former_keys_format;
alter table project_former_keys
  add constraint project_former_keys_format check (key ~ '^[A-Z][A-Z0-9]{0,9}$');

-- ---------------------------------------------------------------------------
-- Stages: the board's lanes, in order. The category is what the product
-- reasons about (planned, active, completed, dropped); the name is what the
-- group calls it and can change freely.
-- ---------------------------------------------------------------------------
create table if not exists subject_stages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  -- Written into styles, so the table refuses anything that is not a colour.
  color       text not null default '#8a8792' check (color ~ '^#[0-9a-f]{6}$'),
  category    text not null check (category in ('planned', 'active', 'completed', 'dropped')),
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

-- Case-insensitive: `Exploring` and `exploring` are the same lane to a person
-- typing `croft subject stage S-12 exploring`.
create unique index if not exists subject_stages_name_unique on subject_stages (lower(name));

insert into subject_stages (name, category, color, position) values
  ('to explore',        'planned',   '#8a8792', 0),
  ('exploring',         'active',    '#6b7fa6', 1),
  ('done',              'completed', '#5f8a63', 2),
  ('rejected',          'dropped',   '#a0685f', 3),
  ('to implement',      'planned',   '#8f8a74', 4),
  ('implementing',      'active',    '#a88a4e', 5),
  ('internal testing',  'active',    '#86709e', 6),
  ('ready for rollout', 'active',    '#4f8c86', 7),
  ('rolled out',        'completed', '#4e7f5a', 8)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Tags: curated, not free-typed. A free-form label list is how `labels` on
-- tasks ended up needing a rename-and-merge tool; a short list an admin keeps
-- tidy is what makes filtering the board by tag mean anything.
-- ---------------------------------------------------------------------------
create table if not exists tags (
  id          uuid primary key default gen_random_uuid(),
  -- Stored lower-cased, so uniqueness is case-insensitive without citext.
  name        text not null check (name = lower(btrim(name)) and char_length(name) between 1 and 40),
  color       text not null default '#8a8792' check (color ~ '^#[0-9a-f]{6}$'),
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists tags_name_unique on tags (name);

-- ---------------------------------------------------------------------------
-- Subjects.
-- ---------------------------------------------------------------------------
create table if not exists subjects (
  id             uuid primary key default gen_random_uuid(),
  -- `S-12`. One sequence for the whole instance: a subject has no project to
  -- number it within. Assigned by trigger, below.
  number         integer not null,
  title          text not null check (char_length(btrim(title)) between 1 and 300),
  body           text,
  -- Restrict, not cascade: deleting a lane must never delete what is in it.
  -- The API refuses first with a readable `stage_in_use`; this is the floor.
  stage_id       uuid not null references subject_stages(id) on delete restrict,
  owner_user_id  uuid references app_users(id) on delete set null,
  conclusion     text,
  concluded_at   timestamptz,
  position       integer not null default 0,
  actor_type     text not null check (actor_type in ('human', 'agent')),
  actor_id       text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz,
  -- Title and conclusion weigh most: the conclusion is the recorded answer,
  -- which is what `croft check` is looking for, the same reason a task's
  -- resolution is weighted A in 002.
  search_vector  tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(conclusion, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) stored,
  constraint subjects_number_unique unique (number)
);

create index if not exists subjects_stage_idx  on subjects (stage_id, position);
create index if not exists subjects_owner_idx  on subjects (owner_user_id) where owner_user_id is not null;
create index if not exists subjects_search_idx on subjects using gin (search_vector);

-- Gapless and race-free: the transaction-scoped advisory lock serialises the
-- max() read, so two subjects created at once cannot both become S-13. A
-- sequence would be simpler and would leave holes on every rolled-back
-- insert, and a missing S-12 reads as a deleted subject.
create or replace function assign_subject_number() returns trigger
language plpgsql
as $$
begin
  if new.number is null then
    perform pg_advisory_xact_lock(hashtext('subjects.number'));
    select coalesce(max(number), 0) + 1 into new.number from subjects;
  end if;
  return new;
end
$$;

drop trigger if exists subjects_assign_number on subjects;
create trigger subjects_assign_number
  before insert on subjects
  for each row execute function assign_subject_number();

drop trigger if exists subjects_touch on subjects;
create trigger subjects_touch
  before update on subjects
  for each row execute function touch_updated_at();

create table if not exists subject_tags (
  subject_id  uuid not null references subjects(id) on delete cascade,
  tag_id      uuid not null references tags(id) on delete cascade,
  primary key (subject_id, tag_id)
);
create index if not exists subject_tags_tag_idx on subject_tags (tag_id);

-- ---------------------------------------------------------------------------
-- The work log. Append-only, like task notes, and idempotent the same way: a
-- retry after a timeout carries the same content hash and writes nothing.
-- `stage` notes are written by the server on every stage change, so the log
-- reads as the subject's history without a second table.
-- ---------------------------------------------------------------------------
create table if not exists subject_notes (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references subjects(id) on delete cascade,
  kind          text not null default 'note'
                check (kind in ('note', 'finding', 'decision', 'attempt', 'handoff', 'stage')),
  note          text not null,
  actor_type    text not null check (actor_type in ('human', 'agent')),
  actor_id      text not null,
  -- The human behind the actor, as a real user: actor_id is a frozen label.
  user_id       uuid references app_users(id) on delete set null,
  content_hash  text,
  created_at    timestamptz not null default now(),
  constraint subject_notes_dedupe unique (subject_id, content_hash)
);
create index if not exists subject_notes_subject_idx on subject_notes (subject_id, created_at desc);

-- A note is activity on the subject, so the board's "recently touched" order
-- sees it — the same reason 008 touches a task when it is noted.
create or replace function touch_subject_from_note() returns trigger
language plpgsql
as $$
begin
  update subjects set updated_at = now() where id = new.subject_id;
  return null;
end
$$;

drop trigger if exists subject_notes_touch_subject on subject_notes;
create trigger subject_notes_touch_subject
  after insert on subject_notes
  for each row execute function touch_subject_from_note();

-- ---------------------------------------------------------------------------
-- Todos are tasks. Set null, not cascade: a todo outlives an archived or
-- deleted subject as ordinary work rather than vanishing with it.
--
-- The cairn_* columns record a todo handed to a Cairn instance by
-- `croft push`: which Cairn task it became, and what Cairn last said about it.
-- ---------------------------------------------------------------------------
alter table tasks add column if not exists subject_id uuid references subjects(id) on delete set null;
alter table tasks add column if not exists cairn_ref text;
alter table tasks add column if not exists cairn_status text;
alter table tasks add column if not exists cairn_synced_at timestamptz;

create index if not exists tasks_subject_idx on tasks (subject_id) where subject_id is not null;
create index if not exists tasks_cairn_ref_idx on tasks (cairn_ref) where cairn_ref is not null;

-- ---------------------------------------------------------------------------
-- The Cairn this instance hands work to. One row, like instance_branding.
-- The key is stored because the server has to present it; it is never read
-- back out through the API, which only ever says whether one is set.
-- ---------------------------------------------------------------------------
create table if not exists cairn_connection (
  id              boolean primary key default true check (id),
  url             text check (url is null or url ~ '^https?://'),
  api_key         text,
  last_synced_at  timestamptz,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references app_users(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Mentions follow the key rule: `T-41` written in a note is a reference now.
-- Refs still resolve only against real projects, so `S-12` (no project S)
-- and `UTF-8` stay prose. Body unchanged from 059 apart from the two regexes.
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

  if p_text is null or p_text !~ '[A-Z][A-Z0-9]{0,9}-[0-9]' then
    return;
  end if;

  insert into task_mentions
    (target_task_id, source_task_id, source, note_id, comment_id, ref_as_written, created_at)
  select distinct on (t.id)
         t.id, p_source_task, p_source, p_note, p_comment, r.written, coalesce(p_at, now())
    from (
      select m[1] as key, m[2]::int as number, m[1] || '-' || m[2] as written
        from regexp_matches(p_text, '\m([A-Z][A-Z0-9]{0,9})-([0-9]{1,6})\M', 'g') as m
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

-- ---------------------------------------------------------------------------
-- Search: subjects become a fifth arm of search_all, so `croft check` and the
-- command palette find a subject and its conclusion the way they find a task
-- and its resolution.
--
-- Transformed, not re-copied (see 055): the installed definition is edited
-- at two anchors, each of which must appear exactly once, and the behaviour
-- earlier migrations installed is asserted to have survived.
-- ---------------------------------------------------------------------------
do $migration$
declare
  fn oid;
  definition text;
  updated text;
  old_candidates text;
  new_candidates text;
  found int;
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'search_all';

  if fn is null then
    raise exception 'search_all is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%070: subjects%' then
    raise notice 'search_all already searches subjects; nothing to do';
    return;
  end if;

  old_candidates := $old$  candidates as (
    select * from task_rows      union all
    select * from note_rows      union all
    select * from knowledge_rows union all
    select * from session_rows
  ),$old$;

  new_candidates := $new$  -- 070: subjects are searched too. No project, so a project-scoped search
  -- leaves them out, as it leaves out anything filed elsewhere. The stage
  -- name is the status; a recorded conclusion is the answer.
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
    select * from task_rows      union all
    select * from note_rows      union all
    select * from knowledge_rows union all
    select * from session_rows   union all
    select * from subject_rows
  ),$new$;

  found := (length(definition) - length(replace(definition, old_candidates, ''))) / length(old_candidates);
  if found <> 1 then
    raise exception 'search_all: expected exactly one candidates CTE to replace, found %', found;
  end if;
  updated := replace(definition, old_candidates, new_candidates);

  if updated = definition or updated not like '%select * from subject_rows%' then
    raise exception 'search_all: the rewrite produced no subject arm';
  end if;
  -- What this migration must NOT have cost: 055's two arms, 038's knowledge
  -- scoping, 033's superseded demotion and 048's removal of owner predicates.
  if updated not like '%055: both arms run%'
     or updated not like '%join project_entities ep on ep.entity_id = ke.entity_id%'
     or updated not like '%case when hits.status = ''superseded'' then 0.4 else 1 end%'
     or updated like '%owner_user_id = p_owner%' then
    raise exception 'search_all: the rewrite lost behaviour an earlier migration installed';
  end if;

  execute updated;
end
$migration$;

comment on function search_all(uuid, text, text[], text, text[], int, int) is
  'Prior-work retrieval over tasks, notes, knowledge, sessions and subjects. Both '
  'arms always run and are merged: the precise arm returns rows carrying at least '
  'half the distinctive terms, the wide arm everything matching any of them, and a '
  'row found by both appears once, in the precise head. p_min_precise caps how many '
  'precise rows lead the answer.';

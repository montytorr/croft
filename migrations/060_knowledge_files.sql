-- ===========================================================================
-- 060: which files a fact is about, stored (CROFT-269)
--
-- Staleness already works out what files a fact concerns — backticked paths
-- in its body, and what its source task or session touched — but only at read
-- time, only for the entries being aged, and nowhere it could be asked the
-- other way round. "What do we know about this file" went through
-- `file_touches.knowledge_id`, which nothing has ever written, so it always
-- answered nothing.
--
-- WHY NOT `file_touches.knowledge_id`. `file_touches` is a log of touches, and
-- staleness counts every row on a path since a fact was last confirmed. An
-- anchor written there is a touch: every fact naming the same file would read
-- as having had its file reworked the moment another fact was learned about
-- it. A link is not an event, so it gets a table of its own.
--
-- Three origins, kept apart so each can be refreshed without disturbing the
-- others:
--   body      backticked paths in the body, re-read whenever the body changes
--   source    files the source task or session had touched when it was learned
--   explicit  named by whoever wrote it (`--files`), replaced only by them
--
-- `body` and `source` are kept by trigger, so every write path fills them. The
-- body rule is `filesNamedIn` in src/lib/api/staleness.ts, restated here; an
-- integration test holds the two to the same answers.
-- ===========================================================================

create table if not exists knowledge_files (
  knowledge_id  uuid not null references knowledge(id) on delete cascade,
  path          text not null,
  origin        text not null check (origin in ('body', 'source', 'explicit')),
  created_at    timestamptz not null default now(),
  primary key (knowledge_id, path, origin)
);

create index if not exists knowledge_files_path_idx on knowledge_files (path);
create index if not exists knowledge_files_base_idx on knowledge_files (split_part(path, '/', -1));

comment on table knowledge_files is
  'The files a knowledge entry is about: named in its body, touched by the work it came from, or named explicitly. A link, not a touch — staleness counts touches from file_touches.';

-- ---------------------------------------------------------------------------
-- The body rule, as `filesNamedIn` states it: a backticked span that is a path
-- (a slash, no spaces, optionally rooted at ~ . .. or /) ending in a real
-- extension. `croft check` and `owner/repo` are not files.
-- ---------------------------------------------------------------------------

create or replace function knowledge_paths_in(p_body text) returns setof text
language sql
immutable
as $$
  select distinct candidate
    from (
      select regexp_replace(m[1], '^\s+|\s+$', '', 'g') as candidate
        from regexp_matches(coalesce(p_body, ''), '`([^`' || chr(10) || ']+)`', 'g') as m
    ) spans
   where candidate ~ '^(((~|\.\.?)?(/[A-Za-z0-9_.@-]+)+)|([A-Za-z0-9_.@-]+(/[A-Za-z0-9_.@-]+)+))$'
     and candidate ~ '\.[A-Za-z]{1,6}$'
$$;

-- `normalisePath` in src/lib/api/files.ts, so a link and a touch of the same
-- file are the same string: `./x/y.md` in a body is `x/y.md` in file_touches.
create or replace function knowledge_normalise_path(p_path text) returns text
language sql
immutable
as $$
  select regexp_replace(regexp_replace(regexp_replace(btrim(p_path), '^\./', ''), '/{2,}', '/', 'g'), '/$', '')
$$;

create or replace function knowledge_files_sync() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.body is distinct from old.body then
    delete from knowledge_files where knowledge_id = new.id and origin = 'body';
    insert into knowledge_files (knowledge_id, path, origin)
    select new.id, knowledge_normalise_path(p), 'body' from knowledge_paths_in(new.body) as p
    on conflict do nothing;
  end if;

  if tg_op = 'INSERT'
     or new.source_task_id is distinct from old.source_task_id
     or new.source_session_id is distinct from old.source_session_id then
    delete from knowledge_files where knowledge_id = new.id and origin = 'source';
    insert into knowledge_files (knowledge_id, path, origin)
    select new.id, ft.path, 'source' from file_touches ft where ft.task_id = new.source_task_id
    union
    select new.id, ft.path, 'source' from file_touches ft where ft.session_id = new.source_session_id
    on conflict do nothing;
  end if;

  return null;
end
$$;

drop trigger if exists knowledge_files_sync on knowledge;
create trigger knowledge_files_sync
  after insert or update of body, source_task_id, source_session_id on knowledge
  for each row execute function knowledge_files_sync();

-- ---------------------------------------------------------------------------
-- Everything already written.
-- ---------------------------------------------------------------------------

insert into knowledge_files (knowledge_id, path, origin)
select k.id, knowledge_normalise_path(p), 'body'
  from knowledge k
  cross join lateral knowledge_paths_in(k.body) as p
on conflict do nothing;

-- Two joins rather than one with an OR, so each can use its own index.
insert into knowledge_files (knowledge_id, path, origin)
select k.id, ft.path, 'source'
  from knowledge k join file_touches ft on ft.task_id = k.source_task_id
union
select k.id, ft.path, 'source'
  from knowledge k join file_touches ft on ft.session_id = k.source_session_id
on conflict do nothing;

comment on column file_touches.knowledge_id is
  'Unused: never written. Knowledge-to-file links live in knowledge_files (060), because a link is not a touch.';

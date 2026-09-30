-- ===========================================================================
-- 075: people's notes on a subject, and files on a subject
--
-- A subject had two places to write: the write-up (one shared document) and
-- the work log (append-only, what was found and tried, mostly by agents).
-- Neither is where a person jots "asked Marc, he says the licence is per
-- seat" and comes back to fix it tomorrow. `subject_human_notes` is that
-- place: free markdown, editable and removable by its author.
--
-- An agent may write one too, and it is attributed to its human (`user_id`):
-- the note is the person's, the key that carried it is provenance only.
--
-- `subject_attachments` mirrors `task_attachments` (001): screenshots, an
-- HTML report, a PDF on the subject itself rather than on one of its todos.
-- The bytes live in the same store under `subjects/{subject_id}/…`; the row
-- records who put them there.
--
-- Both join the live-update fingerprint, so a note or a file added in one tab
-- shows up in every other one without a reload.
-- ===========================================================================

create table if not exists subject_human_notes (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references subjects(id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 100000),
  -- The author. Set null rather than cascade, as a log note's user is (070):
  -- a person leaving must not take what they wrote with them.
  user_id     uuid references app_users(id) on delete set null,
  -- Who carried the write: the human, or one of their agents. Provenance only;
  -- the note belongs to `user_id`.
  actor_type  text not null check (actor_type in ('human', 'agent')),
  actor_id    text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists subject_human_notes_subject_idx
  on subject_human_notes (subject_id, created_at desc);

drop trigger if exists subject_human_notes_touch on subject_human_notes;
create trigger subject_human_notes_touch
  before update on subject_human_notes
  for each row execute function touch_updated_at();

-- A note is activity on the subject (070's reasoning for the log).
drop trigger if exists subject_human_notes_touch_subject on subject_human_notes;
create trigger subject_human_notes_touch_subject
  after insert on subject_human_notes
  for each row execute function touch_subject_from_note();

create table if not exists subject_attachments (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references subjects(id) on delete cascade,
  -- As uploaded, for display and the download's name. The stored object's
  -- name is sanitised separately, inside `storage_path`.
  filename      text not null check (char_length(filename) between 1 and 255),
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes >= 0),
  storage_path  text not null unique,
  sha256        text,
  -- The actor label (`claude-code · cal@…`, or the person), frozen at upload.
  uploaded_by   text not null,
  user_id       uuid references app_users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists subject_attachments_subject_idx on subject_attachments (subject_id, created_at);

drop trigger if exists subject_attachments_touch_subject on subject_attachments;
create trigger subject_attachments_touch_subject
  after insert on subject_attachments
  for each row execute function touch_subject_from_note();

-- ---------------------------------------------------------------------------
-- croft_pulse: 074's definition plus the two new stores. Human notes carry an
-- updated_at that moves on an edit; attachments are never edited, so their
-- newest created_at and a count (a deletion does not move a max) suffice.
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
    ) end,
    -- 074: lab projects.
    case when p_project is not null then '' else (
      select coalesce(max(lp.updated_at)::text, '-') || ':' || count(*)::text
        from lab_projects lp
    ) end,
    -- 075: people's notes and files on subjects.
    case when p_project is not null then '' else (
      select coalesce(max(hn.updated_at)::text, '-') || ':' || count(*)::text
        from subject_human_notes hn
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(sa.created_at)::text, '-') || ':' || count(*)::text
        from subject_attachments sa
    ) end
  )
  from scoped_tasks;
$$;

revoke all on function croft_pulse from public;

comment on function croft_pulse is
  'One string that changes whenever anything visible changes: tasks, activity, and the '
  'lab (subjects, their notes, human notes, files and tags, stages, tags, lab projects). '
  'Read by the SSE stream every few seconds, so it must stay index-cheap.';

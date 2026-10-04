-- ===========================================================================
-- 080: generic hand-off
--
-- A todo may be handed off to any task tracker, not one in particular: which
-- tracker, the task it became there (ref, optional url), and what that tracker
-- last said about it. The tracker owns the todo's status from then on.
-- A lab project may name where its todos go: a tracker and a target in it
-- (a project key, an `owner/repo`).
--
-- Existing links were all Cairn's, so they are backfilled with tracker
-- 'cairn'. Idempotent: every step checks before it renames, adds or checks.
-- ===========================================================================

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = current_schema() and table_name = 'tasks' and column_name = 'cairn_ref') then
    alter table tasks rename column cairn_ref to handoff_ref;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = current_schema() and table_name = 'tasks' and column_name = 'cairn_status') then
    alter table tasks rename column cairn_status to handoff_status;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = current_schema() and table_name = 'tasks' and column_name = 'cairn_synced_at') then
    alter table tasks rename column cairn_synced_at to handoff_synced_at;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = current_schema() and table_name = 'lab_projects' and column_name = 'cairn_key') then
    alter table lab_projects rename column cairn_key to handoff_target;
  end if;
end $$;

alter table tasks add column if not exists handoff_ref text;
alter table tasks add column if not exists handoff_status text;
alter table tasks add column if not exists handoff_synced_at timestamptz;
alter table tasks add column if not exists handoff_tracker text;
alter table tasks add column if not exists handoff_url text;

alter table lab_projects add column if not exists handoff_target text;
alter table lab_projects add column if not exists handoff_tracker text;

update tasks set handoff_tracker = 'cairn' where handoff_ref is not null and handoff_tracker is null;
update lab_projects set handoff_tracker = 'cairn' where handoff_target is not null and handoff_tracker is null;

-- Cairn's key shape (074) is one tracker's rule; the target is any tracker's.
alter table lab_projects drop constraint if exists lab_projects_cairn_key_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_handoff_pair_check') then
    alter table tasks add constraint tasks_handoff_pair_check
      check ((handoff_ref is null) = (handoff_tracker is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lab_projects_handoff_pair_check') then
    alter table lab_projects add constraint lab_projects_handoff_pair_check
      check ((handoff_target is null) = (handoff_tracker is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_handoff_tracker_shape_check') then
    alter table tasks add constraint tasks_handoff_tracker_shape_check
      check (handoff_tracker is null or handoff_tracker ~ '^[a-z][a-z0-9-]{1,31}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lab_projects_handoff_tracker_shape_check') then
    alter table lab_projects add constraint lab_projects_handoff_tracker_shape_check
      check (handoff_tracker is null or handoff_tracker ~ '^[a-z][a-z0-9-]{1,31}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lab_projects_handoff_target_shape_check') then
    alter table lab_projects add constraint lab_projects_handoff_target_shape_check
      check (handoff_target is null or handoff_target ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$');
  end if;
end $$;

drop index if exists tasks_cairn_ref_idx;
create index if not exists tasks_handoff_ref_idx on tasks (handoff_tracker, handoff_ref) where handoff_ref is not null;

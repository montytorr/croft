-- ===========================================================================
-- 071: the lab moves the live-update pulse
--
-- Every page listens to one fingerprint, `croft_pulse` (037, made workspace-wide
-- by 048), and refreshes when it changes. It was made of tasks, sessions,
-- knowledge and activity — so an agent filing a subject, logging a finding,
-- moving a subject along the board, or an admin renaming a stage or a tag,
-- changed nothing a board or subject page could see until someone reloaded.
--
-- The same method as tasks: the newest timestamp and a row count per store (a
-- deletion does not move a max). That needs a timestamp that moves on every
-- change, so:
--   * stages and tags get `updated_at`, kept by the existing touch trigger;
--   * a subject's tags live in `subject_tags`, which has no row to date, so
--     adding or removing one touches the subject — as a note already does
--     (070), and for the same reason: it is a change to that subject.
--
-- Project scope stays tasks-only, as 037 decided: a project page shows that
-- project's tasks. Every lab page subscribes unscoped.
-- ===========================================================================

alter table subject_stages add column if not exists updated_at timestamptz not null default now();
alter table tags           add column if not exists updated_at timestamptz not null default now();

drop trigger if exists subject_stages_touch on subject_stages;
create trigger subject_stages_touch
  before update on subject_stages
  for each row execute function touch_updated_at();

drop trigger if exists tags_touch on tags;
create trigger tags_touch
  before update on tags
  for each row execute function touch_updated_at();

create or replace function touch_subject_from_tag() returns trigger
language plpgsql
as $$
begin
  -- On a cascade from a deleted subject the row is already gone; the update
  -- then matches nothing, which is right.
  update subjects set updated_at = now()
   where id = case when tg_op = 'DELETE' then old.subject_id else new.subject_id end;
  return null;
end
$$;

drop trigger if exists subject_tags_touch_subject on subject_tags;
create trigger subject_tags_touch_subject
  after insert or delete on subject_tags
  for each row execute function touch_subject_from_tag();

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
      select coalesce(max(s.updated_at)::text, '-') || ':' || count(*)::text
        from sessions s
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(k.updated_at)::text, '-') || ':' || count(*)::text
        from knowledge k
    ) end,
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

revoke all on function croft_pulse from public;

comment on function croft_pulse is
  'One string that changes whenever anything visible changes: tasks, sessions, knowledge, '
  'activity, and the lab (subjects, their notes and tags, stages, tags). Read by the SSE '
  'stream every few seconds, so it must stay index-cheap.';

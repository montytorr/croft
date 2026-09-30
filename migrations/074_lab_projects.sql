-- ===========================================================================
-- 074: lab projects
--
-- A subject belongs to at most one lab project — Trig, Croft, Dispofi — from
-- a short list an administrator keeps, the way tags are kept. The board
-- filters by it, and each project may name the Cairn project that receives
-- its todos on `croft push T-n` (`cairn_key`), so a push needs no `--to`.
--
-- Not a task container: the task `projects` table is where todos live (all of
-- them in the system project `T`, as `T-n`), and a lab project never numbers
-- anything. Per-project todo refs would collide with Cairn's own keys.
--
-- Names keep the case they were typed in and are unique in any case, as
-- stages are (070): `croft subject edit S-12 --project trig` finds `Trig`.
-- ===========================================================================

create table if not exists lab_projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  -- Written into styles, so the table refuses anything that is not a colour.
  color       text not null default '#8a8792' check (color ~ '^#[0-9a-f]{6}$'),
  -- Cairn's own key shape: two to ten characters, a letter first.
  cairn_key   text check (cairn_key is null or cairn_key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);

create unique index if not exists lab_projects_name_unique on lab_projects (lower(name));

drop trigger if exists lab_projects_touch on lab_projects;
create trigger lab_projects_touch
  before update on lab_projects
  for each row execute function touch_updated_at();

-- Restrict, not set null: deleting a project must never silently ungroup its
-- subjects. The API refuses first with a readable `project_in_use`; this is
-- the floor.
alter table subjects
  add column if not exists project_id uuid references lab_projects(id) on delete restrict;

create index if not exists subjects_project_idx on subjects (project_id) where project_id is not null;

-- ---------------------------------------------------------------------------
-- croft_pulse: the lab projects join the fingerprint. A subject moved between
-- projects already moves `subjects.updated_at` (its touch trigger); renaming
-- or recolouring a project moves nothing else a page can see.
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
    ) end
  )
  from scoped_tasks;
$$;

revoke all on function croft_pulse from public;

comment on function croft_pulse is
  'One string that changes whenever anything visible changes: tasks, activity, and the '
  'lab (subjects, their notes and tags, stages, tags, lab projects). Read by the SSE '
  'stream every few seconds, so it must stay index-cheap.';

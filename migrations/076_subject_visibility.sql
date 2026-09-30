-- 076: private and member-scoped subjects.
--
-- Until now every subject in the lab was visible to everyone signed in. A
-- subject can now be:
--
--   lab      everyone (the default, and what every existing subject stays)
--   members  its owner and the people on subject_members
--   private  its owner alone
--
-- One rule decides who sees what, and it lives in exactly one place:
-- croft_subject_visible(subject, viewer). A todo (a task with a subject_id)
-- inherits its subject's visibility; a task without a subject is visible to
-- everyone, as before. croft_task_visible(subject_id, viewer) says that.
--
-- The admin exception: an ACTIVE admin sees a non-lab subject only when its
-- owner is gone (deactivated, deleted, or null) — otherwise a private subject
-- whose owner left would be unreachable forever. Admins do not otherwise see
-- other people's private subjects.
--
-- Hidden is the same as missing. Every read path that could surface a subject,
-- a todo, or anything hanging off them filters through the helpers: the RPCs
-- redefined at the bottom of this file, and the TypeScript queries that call
-- the helpers directly.
--
-- The schema half of this file is written to be re-runnable (if not exists /
-- create or replace), because the helpers had to exist on development
-- databases before the rest of the migration was finished. The function
-- rewrites are not: they transform the definitions installed immediately
-- before this migration, and refuse to run on a shape they do not recognise.

-- ---------------------------------------------------------------------------
-- 1. Visibility and membership.
-- ---------------------------------------------------------------------------

alter table subjects add column if not exists visibility text not null default 'lab';
alter table subjects drop constraint if exists subjects_visibility_check;
alter table subjects add constraint subjects_visibility_check
  check (visibility in ('private', 'members', 'lab'));

-- Most subjects are lab subjects; the partial index covers the ones every
-- visibility check has to look harder at.
create index if not exists subjects_visibility_idx on subjects (visibility) where visibility <> 'lab';

create table if not exists subject_members (
  subject_id uuid        not null references subjects(id) on delete cascade,
  user_id    uuid        not null references app_users(id) on delete cascade,
  added_by   uuid        references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (subject_id, user_id)
);
create index if not exists subject_members_user_idx on subject_members (user_id);

-- A private or members-only subject must have an owner: with none, nobody but
-- an admin could ever see it. Refused when a subject is created that way or
-- made non-lab without one, and when its owner is cleared by hand.
--
-- Not a CHECK constraint, on purpose: owner_user_id is ON DELETE SET NULL, and
-- hard-deleting a user must still succeed. That update comes from the foreign
-- key's own trigger (pg_trigger_depth() > 1), and leaves the subject owned by
-- nobody — which is exactly the case the admin exception exists for.
create or replace function subjects_require_owner()
returns trigger
language plpgsql
as $$
begin
  if new.visibility <> 'lab'
     and new.owner_user_id is null
     and (tg_op = 'INSERT' or pg_trigger_depth() = 1) then
    raise exception 'a % subject must have an owner', new.visibility
      using errcode = '23514', constraint = 'subjects_owner_required';
  end if;
  return new;
end
$$;

drop trigger if exists subjects_require_owner on subjects;
create trigger subjects_require_owner
  before insert or update of visibility, owner_user_id on subjects
  for each row execute function subjects_require_owner();

-- The log says when a subject was published, shared or made private. Written
-- by the server only, like `stage`.
alter table subject_notes drop constraint if exists subject_notes_kind_check;
alter table subject_notes add constraint subject_notes_kind_check
  check (kind in ('note', 'finding', 'decision', 'attempt', 'handoff', 'stage', 'visibility'));

-- ---------------------------------------------------------------------------
-- 2. Deleting a subject must never make its todos public.
--
-- With ON DELETE SET NULL a todo whose subject was deleted became a task with
-- no subject — visible to everyone. RESTRICT: the todos go (or move) first.
-- ---------------------------------------------------------------------------

alter table tasks drop constraint if exists tasks_subject_id_fkey;
alter table tasks add constraint tasks_subject_id_fkey
  foreign key (subject_id) references subjects(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- 3. Activity remembers which subject it was about.
--
-- An event outlives its task (task_id is ON DELETE SET NULL), and a tombstone
-- carries the deleted todo's ref and title in `data`. Stamped from the task at
-- insert so the feed can still hide it once the task is gone. No foreign key:
-- a stamp naming a subject that no longer exists fails closed, because the
-- helper finds no subject and answers false.
-- ---------------------------------------------------------------------------

alter table task_activity_events add column if not exists subject_id uuid;
create index if not exists task_activity_events_subject_idx
  on task_activity_events (subject_id) where subject_id is not null;

create or replace function task_activity_stamp_subject()
returns trigger
language plpgsql
as $$
begin
  if new.subject_id is null and new.task_id is not null then
    select t.subject_id into new.subject_id from tasks t where t.id = new.task_id;
  end if;
  return new;
end
$$;

drop trigger if exists task_activity_stamp_subject on task_activity_events;
create trigger task_activity_stamp_subject
  before insert on task_activity_events
  for each row execute function task_activity_stamp_subject();

update task_activity_events e
   set subject_id = t.subject_id
  from tasks t
 where t.id = e.task_id
   and t.subject_id is not null
   and e.subject_id is null;

-- ---------------------------------------------------------------------------
-- 4. The rule.
-- ---------------------------------------------------------------------------

-- Active, by the same test sign-in uses.
create or replace function croft_user_active(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select u.deleted_at is null
       and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()
      from app_users u
     where u.id = p_user
  ), false);
$$;

create or replace function croft_subject_visible(p_subject uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select s.visibility = 'lab'
        or (p_viewer is not null and (
             s.owner_user_id = p_viewer
          or (s.visibility = 'members'
              and exists (select 1 from subject_members m
                           where m.subject_id = s.id and m.user_id = p_viewer))
          or (not croft_user_active(s.owner_user_id)
              and exists (select 1 from app_users v
                           where v.id = p_viewer
                             and v.role = 'admin'
                             and v.deleted_at is null
                             and coalesce(v.banned_until, '-infinity'::timestamptz) <= now()))
        ))
      from subjects s
     where s.id = p_subject
  ), false);
$$;

create or replace function croft_task_visible(p_subject_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_subject_id is null or croft_subject_visible(p_subject_id, p_viewer);
$$;

-- Every subject p_viewer can see, as a set. The RPCs below filter with
-- `subject_id in (select croft_visible_subjects(p_owner))`, which evaluates
-- the rule once per subject rather than once per task, event or note.
create or replace function croft_visible_subjects(p_viewer uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id
    from subjects s
   where s.visibility = 'lab' or croft_subject_visible(s.id, p_viewer);
$$;

revoke all on function croft_user_active(uuid) from public;
revoke all on function croft_visible_subjects(uuid) from public;
revoke all on function croft_subject_visible(uuid, uuid) from public;
revoke all on function croft_task_visible(uuid, uuid) from public;

comment on function croft_subject_visible(uuid, uuid) is
  'Whether p_viewer may see subject p_subject: a lab subject, the owner, a member of a '
  'members subject, or an active admin when the owner is gone. False for a subject that '
  'does not exist and, for a non-lab subject, for a null viewer. The one place the rule lives.';
comment on function croft_task_visible(uuid, uuid) is
  'Whether p_viewer may see a task whose subject_id is p_subject_id: true when it has no '
  'subject, otherwise croft_subject_visible.';

-- ---------------------------------------------------------------------------
-- 5. The read RPCs honour the rule.
--
-- Every one of these has taken `p_owner` since it was written, and 048 stopped
-- using it when the workspace became shared. It is the viewer's user id again —
-- the parameter keeps its name and its place because dropping a parameter
-- means dropping the function, and every caller already passes the signed-in
-- user.
--
-- Transformed from the definitions actually installed, never re-copied from an
-- older migration: a re-copied body silently reverts every fix made to the
-- function since. Each swap must find its text exactly once, and the result
-- must still carry what earlier migrations installed. The filter goes inside
-- the CTEs that rank and limit, never after them: filtering a limited answer
-- would return fewer rows than asked for, and a count taken before the filter
-- would tell an outsider how much is hidden.
-- ---------------------------------------------------------------------------

create function pg_temp.croft_076_swap(p_source text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
declare
  found int;
begin
  found := (length(p_source) - length(replace(p_source, p_old, ''))) / length(p_old);
  if found <> 1 then
    raise exception '076: expected exactly one % to rewrite, found %', p_what, found;
  end if;
  return replace(p_source, p_old, p_new);
end
$$;

create function pg_temp.croft_076_install(p_name text, p_definition text, p_updated text, p_marks int)
returns void
language plpgsql
as $$
declare
  marks int;
begin
  if p_updated = p_definition then
    raise exception '%: the rewrites produced no change', p_name;
  end if;
  marks := (length(p_updated) - length(replace(p_updated, '076:', ''))) / length('076:');
  if marks <> p_marks then
    raise exception '%: expected % rewritten filters, found %', p_name, p_marks, marks;
  end if;
  -- 048's removal of the owner predicates stays removed. The visibility rule
  -- is not an owner predicate, and it only ever lives in the helpers.
  if p_updated ~* '\w+\.owner_user_id\s*=\s*p_owner' then
    raise exception '%: an owner predicate came back', p_name;
  end if;
  execute p_updated;
end
$$;

-- search_tasks: one candidate set feeds both arms, so one filter covers both.
do $migration$
declare
  definition text := pg_get_functiondef('search_tasks(uuid, text, text[], text, text, text, int, int)'::regprocedure);
  updated text := definition;
begin
  updated := pg_temp.croft_076_swap(updated, $old$
      and (p_status  is null or t.status = p_status)
  ),$old$, $new$
      and (p_status  is null or t.status = p_status)
      -- 076: a todo is seen only by those who can see its subject.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
  ),$new$, 'visible CTE');

  if updated not like '%056: both arms run%'
     or updated not like '%(h.resolution is not null) desc%'
     or updated not like '%p_project is null or p.key = upper(p_project)%' then
    raise exception 'search_tasks: the rewrite lost behaviour an earlier migration installed';
  end if;
  perform pg_temp.croft_076_install('search_tasks', definition, updated, 1);
end
$migration$;

-- search_all: each kind is filtered in its own candidate CTE.
do $migration$
declare
  definition text := pg_get_functiondef('search_all(uuid, text, text[], text, text[], int, int)'::regprocedure);
  updated text := definition;
begin
  updated := pg_temp.croft_076_swap(updated, $old$
    where (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'task' = any (w.kinds))$old$, $new$
    where (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'task' = any (w.kinds))
      -- 076: a todo is seen only by those who can see its subject.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))$new$, 'task_rows filter');

  updated := pg_temp.croft_076_swap(updated, $old$
    where (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'note' = any (w.kinds))$old$, $new$
    where (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'note' = any (w.kinds))
      -- 076: and so is its work log.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))$new$, 'note_rows filter');

  updated := pg_temp.croft_076_swap(updated, $old$
    where p_project is null
      and (w.all_kinds or 'subject' = any (w.kinds))$old$, $new$
    where p_project is null
      and (w.all_kinds or 'subject' = any (w.kinds))
      -- 076: private and members-only subjects.
      and s.id in (select croft_visible_subjects(p_owner))$new$, 'subject_rows filter');

  if updated not like '%055: both arms run%'
     or updated not like '%070: subjects%'
     or updated not like '%case hits.kind when ''task'' then 0 when ''note'' then 1 else 2 end%' then
    raise exception 'search_all: the rewrite lost behaviour an earlier migration installed';
  end if;
  perform pg_temp.croft_076_install('search_all', definition, updated, 3);
end
$migration$;

-- activity_feed: every arm, before the union is ordered and limited. An event
-- is hidden when either the subject it was stamped with at the time or its
-- task's subject now is hidden — so a tombstone of a deleted private todo
-- stays hidden, and so does the history of a todo later moved into one.
do $migration$
declare
  definition text := pg_get_functiondef('activity_feed(uuid, timestamptz, int, text, text, text[])'::regprocedure);
  updated text := definition;
begin
  updated := pg_temp.croft_076_swap(updated, $old$
    where t.created_at < c.before
      and (w.all_kinds or 'task' = any (w.kinds))$old$, $new$
    where t.created_at < c.before
      and (w.all_kinds or 'task' = any (w.kinds))
      -- 076: a todo is seen only by those who can see its subject.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))$new$, 'filed filter');

  updated := pg_temp.croft_076_swap(updated, $old$
    where e.created_at < c.before
      and (w.all_kinds or 'event' = any (w.kinds))$old$, $new$
    where e.created_at < c.before
      and (w.all_kinds or 'event' = any (w.kinds))
      -- 076: the subject stamped at the time, and the task's subject now.
      and (e.subject_id is null or e.subject_id in (select croft_visible_subjects(p_owner)))
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))$new$, 'events filter');

  updated := pg_temp.croft_076_swap(updated, $old$
    where n.created_at < c.before
      and (w.all_kinds or 'note' = any (w.kinds))$old$, $new$
    where n.created_at < c.before
      and (w.all_kinds or 'note' = any (w.kinds))
      -- 076: a todo's work log.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))$new$, 'notes filter');

  updated := pg_temp.croft_076_swap(updated, $old$
    where c.created_at < cl.before
      and (w.all_kinds or 'comment' = any (w.kinds))$old$, $new$
    where c.created_at < cl.before
      and (w.all_kinds or 'comment' = any (w.kinds))
      -- 076: a todo's comments.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))$new$, 'comments filter');

  if updated not like '%e.data->>''ref''%'
     or updated not like '%croft_clip(regexp_replace(c.content%'
     or updated not like '%order by e.at desc%' then
    raise exception 'activity_feed: the rewrite lost behaviour an earlier migration installed';
  end if;
  perform pg_temp.croft_076_install('activity_feed', definition, updated, 4);
end
$migration$;

-- list_labels: counts are the viewer's counts. A label carried only by
-- someone's private todos is not in anyone else's list.
do $migration$
declare
  definition text := pg_get_functiondef('list_labels(uuid)'::regprocedure);
  updated text := definition;
begin
  updated := pg_temp.croft_076_swap(updated, $old$
   where true
$old$, $new$
   -- 076: only the tasks the viewer can see are counted.
   where (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
$new$, 'label filter');

  if updated not like '%order by count(*) desc, l%' then
    raise exception 'list_labels: the rewrite lost behaviour an earlier migration installed';
  end if;
  perform pg_temp.croft_076_install('list_labels', definition, updated, 1);
end
$migration$;

-- rename_label: a write on a todo is for those who can see it. A rename
-- touches only the tasks the caller can see, so it neither edits someone's
-- private todos blind nor reports, in its count, that they exist.
do $migration$
declare
  definition text := pg_get_functiondef('rename_label(uuid, text, text)'::regprocedure);
  updated text := definition;
begin
  updated := pg_temp.croft_076_swap(updated, $old$
     and p_from = any (t.labels);$old$, $new$
     and p_from = any (t.labels)
     -- 076: only the tasks the caller can see.
     and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)));$new$, 'rename filter');

  if updated not like '%get diagnostics affected = row_count%' then
    raise exception 'rename_label: the rewrite lost behaviour an earlier migration installed';
  end if;
  perform pg_temp.croft_076_install('rename_label', definition, updated, 1);
end
$migration$;

-- croft_pulse: the fingerprint moves only for what the viewer can see, so an
-- open tab cannot learn from a refresh that someone's private subject changed.
-- (The events route also hashes it: the raw string is timestamps and counts.)
-- Stages, tags and lab projects are workspace-wide and stay unfiltered.
do $migration$
declare
  definition text := pg_get_functiondef('croft_pulse(uuid, text)'::regprocedure);
  updated text := definition;
begin
  updated := pg_temp.croft_076_swap(updated, $old$
     where p_project is null or p.key = upper(p_project)
  )$old$, $new$
     where (p_project is null or p.key = upper(p_project))
       -- 076: only the tasks the viewer can see.
       and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
  )$new$, 'scoped_tasks filter');

  updated := pg_temp.croft_076_swap(updated, $old$
        from task_activity_events e
$old$, $new$
        from task_activity_events e
        left join tasks t on t.id = e.task_id
       -- 076: as the activity feed filters them.
       where (e.subject_id is null or e.subject_id in (select croft_visible_subjects(p_owner)))
         and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
$new$, 'events aggregate');

  updated := pg_temp.croft_076_swap(updated, $old$
        from subjects su
$old$, $new$
        from subjects su
       where su.id in (select croft_visible_subjects(p_owner)) -- 076: visible only
$new$, 'subjects aggregate');

  updated := pg_temp.croft_076_swap(updated, $old$
        from subject_notes n
$old$, $new$
        from subject_notes n
       where n.subject_id in (select croft_visible_subjects(p_owner)) -- 076: visible only
$new$, 'subject notes aggregate');

  updated := pg_temp.croft_076_swap(updated, $old$
        from subject_tags x
$old$, $new$
        from subject_tags x
       where x.subject_id in (select croft_visible_subjects(p_owner)) -- 076: visible only
$new$, 'subject tags aggregate');

  updated := pg_temp.croft_076_swap(updated, $old$
        from subject_human_notes hn
$old$, $new$
        from subject_human_notes hn
       where hn.subject_id in (select croft_visible_subjects(p_owner)) -- 076: visible only
$new$, 'human notes aggregate');

  updated := pg_temp.croft_076_swap(updated, $old$
        from subject_attachments sa
$old$, $new$
        from subject_attachments sa
       where sa.subject_id in (select croft_visible_subjects(p_owner)) -- 076: visible only
$new$, 'subject files aggregate');

  if updated not like '%from subject_stages st%'
     or updated not like '%from lab_projects lp%'
     or updated not like '%from tags tg%' then
    raise exception 'croft_pulse: the rewrite lost behaviour an earlier migration installed';
  end if;
  perform pg_temp.croft_076_install('croft_pulse', definition, updated, 7);
end
$migration$;

drop function pg_temp.croft_076_install(text, text, text, int);
drop function pg_temp.croft_076_swap(text, text, text, text);

-- Said on each function, after what earlier migrations already said there.
do $migration$
declare
  fn regprocedure;
begin
  foreach fn in array array[
    'search_tasks(uuid, text, text[], text, text, text, int, int)'::regprocedure,
    'search_all(uuid, text, text[], text, text[], int, int)'::regprocedure,
    'activity_feed(uuid, timestamptz, int, text, text, text[])'::regprocedure,
    'list_labels(uuid)'::regprocedure,
    'rename_label(uuid, text, text)'::regprocedure,
    'croft_pulse(uuid, text)'::regprocedure
  ] loop
    execute format('comment on function %s is %L', fn, concat_ws(' ',
      obj_description(fn::oid, 'pg_proc'),
      '076: p_owner is the viewer again. Only what croft_visible_subjects(p_owner) allows is '
      'read, counted or (rename_label) written: todos of subjects the viewer cannot see, and '
      'everything hanging off them, are left out before any limit.'));
  end loop;
end
$migration$;

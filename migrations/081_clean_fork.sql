-- ===========================================================================
-- 081: clean the fork
--
-- Croft is the lab: subjects and their todos, in the one hidden project `T`.
-- What it inherited from the task tracker it was forked from goes: moving
-- tasks between projects, renaming and rekeying projects, project repos, the
-- dependency graph, mention tracking and the task-only search. Their routes,
-- pages and CLI verbs are gone in 0.8.0, so their tables and SQL go too.
--
-- Production holds one project (T). project_repos, task_projects,
-- project_former_keys and task_deps are empty there; task_mentions holds two
-- rows, derived from text that is still in the notes, and is not a record.
--
-- Order matters. Triggers first, because a function a trigger runs cannot be
-- dropped without CASCADE; then the tables; then the functions only they used.
-- Nothing is dropped with CASCADE: if something unexpected still depends on one
-- of these, this migration fails rather than taking it along silently.
--
-- No function that stays refers to anything dropped here. Checked against every
-- migration: task_deps, task_mentions, task_projects, project_repos and
-- project_former_keys are named only by the objects dropped below, and
-- search_all, activity_feed and croft_pulse (the survivors that read tasks and
-- projects) touch none of them. Their text is left alone on purpose.
--
-- Never touched: the projects and tasks rows, labels, activity events (the
-- project_renamed / task_deleted ... history the feed still renders), subjects.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Triggers. The mention triggers sit on tables that stay; the key-namespace
-- guard sits on `projects`, which stays, and reads project_former_keys.
-- ---------------------------------------------------------------------------
drop trigger if exists task_mentions_note on task_notes;
drop trigger if exists task_mentions_comment on task_comments;
drop trigger if exists task_mentions_task on tasks;
drop trigger if exists projects_key_namespace_guard on projects;

-- ---------------------------------------------------------------------------
-- The tables. Their own triggers, indexes and constraints go with them.
-- ---------------------------------------------------------------------------
drop table if exists task_mentions;
drop table if exists project_repos;
drop table if exists task_projects;
drop table if exists project_former_keys;
drop table if exists task_deps;

-- ---------------------------------------------------------------------------
-- The functions only they, the move and the rename used.
-- ---------------------------------------------------------------------------
drop function if exists task_mentions_from_note();
drop function if exists task_mentions_from_comment();
drop function if exists task_mentions_from_task();
drop function if exists task_mentions_refresh(text, uuid, uuid, uuid, text, timestamptz);

drop function if exists guard_project_key_namespace();
drop function if exists reject_home_project_link();
-- Whichever argument list 031, 047 and 057 left installed.
do $$
declare
  fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = current_schema() and p.proname = 'project_rename_key'
  loop
    execute format('drop function %s', fn);
  end loop;
end $$;
drop function if exists move_task(uuid, uuid, uuid);
drop function if exists search_tasks(uuid, text, text[], text, text, text, int, int);

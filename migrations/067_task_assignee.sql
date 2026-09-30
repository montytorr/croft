-- Every task has a human assignee (CROFT-310).
--
-- Since the workspace became shared, a task recorded who created it
-- (`actor_id`, a frozen label) and which agent is executing it (`claimed_by`),
-- but never whose it is. Those are three different facts: an agent files work
-- for its human, another agent may claim it, and the human stays accountable
-- for it throughout. The assignee is that human, a real user rather than a
-- label, so it can be filtered on, changed, and survive a rename.

alter table tasks add column assignee_user_id uuid;

-- Backfill from the creator. A `created` event has carried the caller's user
-- since the shared workspace; before it, the column was filled from the project
-- owner, which in the single-user era was the only user and so the creator.
-- A task with no event (inserted directly) falls back to its project's owner.
update tasks t
   set assignee_user_id = coalesce(
     (select e.owner_user_id
        from task_activity_events e
        join app_users u on u.id = e.owner_user_id
       where e.task_id = t.id and e.event = 'created'
       order by e.created_at
       limit 1),
     p.owner_user_id
   )
  from projects p
 where p.id = t.project_id
   and t.assignee_user_id is null;

-- The API always names one. This is the last resort for an insert that does
-- not, so the invariant holds for every writer rather than only the route.
create function tasks_default_assignee() returns trigger
language plpgsql
as $$
begin
  if new.assignee_user_id is null then
    select owner_user_id into new.assignee_user_id from projects where id = new.project_id;
  end if;
  return new;
end
$$;

create trigger tasks_default_assignee
  before insert on tasks
  for each row execute function tasks_default_assignee();

alter table tasks alter column assignee_user_id set not null;

-- Deferred: deleting a user cascades through their projects to those projects'
-- tasks, and an immediate check would fire before that cascade had run. At
-- commit, the only rows left pointing at the user are tasks elsewhere still
-- assigned to them, and the delete is refused for those — as it should be.
-- Added last, after the backfill: a deferred check queued by that update would
-- leave pending trigger events, and Postgres refuses ALTER TABLE while any are.
alter table tasks add constraint tasks_assignee_user_id_fkey
  foreign key (assignee_user_id) references app_users(id) deferrable initially deferred;

create index tasks_assignee_idx on tasks(assignee_user_id)
  where status not in ('done', 'cancelled');

alter table task_activity_events
  drop constraint if exists task_activity_events_event_check;

alter table task_activity_events
  add constraint task_activity_events_event_check
  check (event in (
    'created', 'status_changed', 'priority_changed', 'type_changed',
    'renamed', 'labels_changed', 'due_date_changed', 'body_edited',
    'assignee_changed',
    'resolved', 'resolution_revised', 'resolution_withdrawn',
    'marked_duplicate', 'duplicate_cleared',
    'claimed', 'released', 'blocked', 'unblocked',
    'git_commit', 'git_push', 'run_result',
    'checkpointed', 'auto_checkpointed', 'attachment_added', 'attachment_removed',
    'dependency_added', 'dependency_removed',
    'project_created', 'project_renamed', 'project_key_changed',
    'project_archived', 'project_restored', 'project_deleted',
    'task_deleted', 'knowledge_deleted'
  ));

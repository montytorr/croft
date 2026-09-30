-- ===========================================================================
-- 042: a detached event still knows what it was about
--
-- 040 made activity rows survive their task, which kept the record. It did not
-- keep the NAME: the feed resolves a ref by joining the task, and a detached
-- row has no task, so everything a deleted task ever did collapsed to showing
-- the bare project key.
--
-- The tombstone carries its own ref because the delete handler puts it there.
-- Every other event from the same task needs the same treatment, and the only
-- moment it can be applied is before the row disappears.
-- ===========================================================================

create or replace function croft_stamp_ref(p_task uuid, p_ref text)
returns void
language sql
as $$
  update task_activity_events
     set data = data || jsonb_build_object('ref', p_ref)
   where task_id = p_task
     and data->>'ref' is distinct from p_ref;
$$;

comment on function croft_stamp_ref is
  'Writes the task ref into every one of its activity rows, so they stay '
  'readable after the task is deleted and they detach from it.';

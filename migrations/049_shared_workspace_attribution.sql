-- Qualify attribution that predates the shared workspace.
--
-- Owner columns remain useful here as provenance: before users shared one
-- workspace, `codex` was unambiguous because every reader saw only one owner's
-- rows. It is ambiguous now. New writes already use `codex · Display Name` (or
-- the user's display name for a human); this one-time backfill gives historical
-- rows the same durable identity without changing their ownership metadata.

create function croft_qualify_legacy_actor(
  p_actor_type text,
  p_actor_id text,
  p_owner_user_id uuid
) returns text
language sql
stable
as $$
  select case
    when p_actor_id is null or trim(p_actor_id) = '' then p_actor_id
    when right(p_actor_id, length(' · ' || identity.owner_label)) = ' · ' || identity.owner_label
      then p_actor_id
    when p_actor_type = 'human' then identity.owner_label
    else p_actor_id || ' · ' || identity.owner_label
  end
  from (
    select coalesce(nullif(trim(p.display_name), ''), u.email) as owner_label
      from app_users u
      left join user_profiles p on p.id = u.id
     where u.id = p_owner_user_id
  ) identity
$$;

-- tasks.actor_id, tasks.claimed_by and tasks.resolved_by inherit the legacy
-- owner from their home project. Claims are always agent identities. A
-- resolver may be human or agent, so retained keys disambiguate it.
update tasks t
   set actor_id = croft_qualify_legacy_actor(t.actor_type, t.actor_id, p.owner_user_id),
       claimed_by = case when t.claimed_by is null then null else
         croft_qualify_legacy_actor('agent', t.claimed_by, p.owner_user_id) end,
       resolved_by = case when t.resolved_by is null then null else
         croft_qualify_legacy_actor(
           case when exists (
             select 1 from api_keys k
              where k.user_id = p.owner_user_id and k.agent_name = t.resolved_by
           ) then 'agent' else 'human' end,
           t.resolved_by,
           p.owner_user_id
         ) end
  from projects p
 where p.id = t.project_id;

-- The task children carry actor type but not owner provenance themselves.
-- Resolve it through task -> home project before the owner column stops being
-- an authorization boundary.
update task_notes n
   set actor_id = croft_qualify_legacy_actor(n.actor_type, n.actor_id, p.owner_user_id)
  from tasks t join projects p on p.id = t.project_id
 where t.id = n.task_id;

update task_comments c
   set actor_id = croft_qualify_legacy_actor(c.actor_type, c.actor_id, p.owner_user_id)
  from tasks t join projects p on p.id = t.project_id
 where t.id = c.task_id;

update task_attachments a
   set actor_id = croft_qualify_legacy_actor(a.actor_type, a.actor_id, p.owner_user_id)
  from tasks t join projects p on p.id = t.project_id
 where t.id = a.task_id;

-- Some post-040 task events were still written without the denormalized owner.
-- Their live task retains the legacy provenance, so repair both fields before
-- qualifying tombstones and non-task events that already carry it.
update task_activity_events e
   set owner_user_id = p.owner_user_id,
       actor_id = croft_qualify_legacy_actor(e.actor_type, e.actor_id, p.owner_user_id)
  from tasks t join projects p on p.id = t.project_id
 where e.owner_user_id is null and t.id = e.task_id;

-- task_activity_events.actor_id has explicit provenance since migration 040,
-- including tombstones whose task or project no longer exists.
update task_activity_events e
   set actor_id = croft_qualify_legacy_actor(e.actor_type, e.actor_id, e.owner_user_id)
 where e.owner_user_id is not null;

update knowledge k
   set actor_id = croft_qualify_legacy_actor(k.actor_type, k.actor_id, k.owner_user_id)
 where k.actor_id is not null;

-- sessions.agent_id is always a runtime identity. The hook-supplied value is
-- now qualified at write time as well as the authenticated key fallback.
update sessions s
   set agent_id = croft_qualify_legacy_actor('agent', s.agent_id, s.owner_user_id)
 where s.agent_id is not null;

-- search_events.actor_id may be a browser user or an agent. API keys are
-- retained when revoked, so their historical agent names remain available for
-- this classification.
update search_events s
   set actor_id = croft_qualify_legacy_actor(
     case when exists (
       select 1 from api_keys k
        where k.user_id = s.owner_user_id and k.agent_name = s.actor_id
     ) then 'agent' else 'human' end,
     s.actor_id,
     s.owner_user_id
   );

drop function croft_qualify_legacy_actor(text, text, uuid);

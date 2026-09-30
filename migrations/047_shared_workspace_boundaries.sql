-- Make the legacy owner columns attribution metadata rather than authorization
-- boundaries. Croft has one shared workspace: identifiers are global, and any
-- active user may operate any task. The caller's user id remains on new events
-- so historical ownership and actor attribution are preserved.

-- Project refs must resolve to exactly one project across the workspace.
alter table projects drop constraint if exists projects_key_unique_per_owner;
create unique index if not exists projects_key_unique_workspace on projects (key);

-- These keys are public workspace addresses too. Keeping per-owner uniqueness
-- would make the unscoped API ambiguous as soon as a second user created the
-- same entity or knowledge slug.
drop index if exists entities_owner_key_idx;
create unique index if not exists entities_key_unique_workspace on entities (key);

drop index if exists knowledge_owner_slug_idx;
create unique index if not exists knowledge_slug_unique_workspace on knowledge (slug);

alter table project_former_keys drop constraint if exists project_former_keys_pkey;
alter table project_former_keys add primary key (key);

-- Live and retired project keys share one namespace. Separate unique indexes
-- are insufficient: reusing another project's retired key would make old refs
-- resolve to the new live project before the alias fallback is consulted.
create or replace function guard_project_key_namespace()
returns trigger language plpgsql as $$
begin
  if tg_table_name = 'projects' then
    if exists (
      select 1 from project_former_keys
       where key = new.key and project_id <> new.id
    ) then
      raise exception 'key % is retired by another project', new.key using errcode = '23505';
    end if;
  elsif exists (
    select 1 from projects
     where key = new.key and id <> new.project_id
  ) then
    raise exception 'key % is already used by a live project', new.key using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_key_namespace_guard on projects;
create trigger projects_key_namespace_guard
before insert or update of key on projects
for each row execute function guard_project_key_namespace();

drop trigger if exists former_keys_namespace_guard on project_former_keys;
create trigger former_keys_namespace_guard
before insert or update of key, project_id on project_former_keys
for each row execute function guard_project_key_namespace();

create or replace function project_rename_key(p_project uuid, p_new_key text)
returns text language plpgsql as $$
declare
  v_owner uuid;
  v_old text;
  v_taken uuid;
begin
  select owner_user_id, key into v_owner, v_old from projects where id = p_project;
  if v_owner is null then
    raise exception 'no such project' using errcode = 'P0002';
  end if;
  if v_old = p_new_key then return v_old; end if;

  select project_id into v_taken from project_former_keys where key = p_new_key;
  if v_taken is not null and v_taken <> p_project then
    raise exception 'key % is retired by another project', p_new_key using errcode = '23505';
  end if;

  update projects set key = p_new_key, updated_at = now() where id = p_project;
  delete from project_former_keys where key = p_new_key;
  insert into project_former_keys (owner_user_id, key, project_id)
  values (v_owner, v_old, p_project)
  on conflict (key) do update set project_id = excluded.project_id, retired_at = now();
  return v_old;
end;
$$;

create or replace function move_task(p_owner uuid, p_task uuid, p_project uuid)
returns table (id uuid, number integer, project_key text)
language plpgsql as $$
declare
  v_next integer;
  v_key text;
begin
  if not exists (select 1 from tasks where tasks.id = p_task) then
    raise exception 'task not found';
  end if;

  select projects.key into v_key from projects where projects.id = p_project;
  if v_key is null then raise exception 'project not found'; end if;

  update projects
     set task_counter = task_counter + 1
   where projects.id = p_project
  returning task_counter into v_next;

  update tasks set project_id = p_project, number = v_next where tasks.id = p_task;
  return query select p_task, v_next, v_key;
end;
$$;

create or replace function claim_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_holder text,
  p_stale_before timestamptz,
  p_set_doing boolean default true
) returns jsonb language plpgsql as $$
declare
  before_row tasks%rowtype;
  claimed tasks%rowtype;
begin
  select * into before_row from tasks where id = p_task_id;
  if not found then return null; end if;

  update tasks
     set claimed_by = p_holder,
         claimed_at = now(),
         heartbeat_at = now(),
         attempt = attempt + 1,
         ownership_version = ownership_version + 1,
         status = case when p_set_doing then 'doing' else status end
   where id = p_task_id
     and status not in ('done', 'cancelled')
     and (claimed_by is null or heartbeat_at < p_stale_before)
  returning * into claimed;
  if not found then return null; end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, claimed.project_id, claimed.id, p_actor_type, p_actor_id,
     'claimed', jsonb_build_object('agent', p_holder, 'attempt', claimed.attempt,
       'ownershipVersion', claimed.ownership_version));

  if claimed.status is distinct from before_row.status then
    insert into task_activity_events
      (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
    values
      (p_owner_user_id, claimed.project_id, claimed.id, p_actor_type, p_actor_id,
       'status_changed', jsonb_build_object('from', before_row.status, 'to', claimed.status, 'via', 'claim'));
  end if;

  return to_jsonb(claimed);
end $$;

create or replace function release_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_expected_version bigint,
  p_expected_holder text default null
) returns jsonb language plpgsql as $$
declare released tasks%rowtype;
begin
  update tasks
     set claimed_by = null, claimed_at = null, heartbeat_at = null
   where id = p_task_id
     and ownership_version = p_expected_version
     and (p_expected_holder is null or claimed_by = p_expected_holder)
  returning * into released;
  if not found then return null; end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, released.project_id, released.id, p_actor_type, p_actor_id,
     'released', jsonb_build_object('previousHolder', p_expected_holder,
       'ownershipVersion', p_expected_version));
  return to_jsonb(released);
end $$;

create or replace function checkpoint_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_summary text,
  p_payload jsonb,
  p_mutation_id uuid,
  p_queued_at timestamptz,
  p_expected_version bigint default null,
  p_expected_checkpoint_version bigint default null
) returns jsonb language plpgsql as $$
declare
  current_row tasks%rowtype;
  claimed_now boolean := false;
begin
  select * into current_row from tasks where id = p_task_id for update;
  if not found then return jsonb_build_object('code', 'not_found'); end if;

  if current_row.checkpoint_mutation_id = p_mutation_id then
    return jsonb_build_object('code', 'duplicate', 'data', to_jsonb(current_row));
  end if;
  if current_row.status in ('done', 'cancelled') then
    return jsonb_build_object('code', 'terminal');
  end if;
  if current_row.claimed_by is not null and
     (p_expected_version is null or p_expected_checkpoint_version is null) then
    return jsonb_build_object('code', 'missing_predecessor');
  end if;
  if p_expected_version is not null and
     (current_row.claimed_by is null or current_row.ownership_version <> p_expected_version) then
    return jsonb_build_object('code', 'ownership_changed', 'version', current_row.ownership_version);
  end if;
  if p_expected_checkpoint_version is not null and
     current_row.checkpoint_version <> p_expected_checkpoint_version then
    return jsonb_build_object('code', 'checkpoint_changed', 'version', current_row.checkpoint_version);
  end if;

  if current_row.claimed_by is null and p_actor_type = 'agent' then
    update tasks set
      claimed_by = p_actor_id, claimed_at = now(), heartbeat_at = now(),
      attempt = attempt + 1, ownership_version = ownership_version + 1,
      status = 'doing'
    where id = p_task_id returning * into current_row;
    claimed_now := true;
  elsif current_row.claimed_by is distinct from p_actor_id and p_actor_type = 'agent' then
    return jsonb_build_object('code', 'already_claimed', 'holder', current_row.claimed_by);
  end if;

  update tasks set
    checkpoint_summary = p_summary,
    checkpoint_payload = p_payload,
    checkpoint_at = now(),
    checkpoint_version = checkpoint_version + 1,
    checkpoint_mutation_id = p_mutation_id,
    heartbeat_at = case when claimed_by = p_actor_id then now() else heartbeat_at end
  where id = p_task_id returning * into current_row;

  if claimed_now then
    insert into task_activity_events
      (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
    values
      (p_owner_user_id, current_row.project_id, current_row.id, p_actor_type, p_actor_id,
       'claimed', jsonb_build_object('agent', p_actor_id, 'attempt', current_row.attempt,
         'ownershipVersion', current_row.ownership_version)),
      (p_owner_user_id, current_row.project_id, current_row.id, p_actor_type, p_actor_id,
       'status_changed', jsonb_build_object('to', 'doing', 'via', 'checkpoint'));
  end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, current_row.project_id, current_row.id, p_actor_type, p_actor_id,
     'checkpointed', jsonb_build_object('summary', left(p_summary, 300),
       'queuedAt', p_queued_at,
       'checkpointVersion', current_row.checkpoint_version,
       'ownershipVersion', current_row.ownership_version));

  return jsonb_build_object('code', 'ok', 'data', to_jsonb(current_row), 'claimed', claimed_now);
end $$;

create or replace function reconcile_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_expected_holder text,
  p_expected_version bigint,
  p_expected_heartbeat timestamptz,
  p_expected_updated_at timestamptz,
  p_reopen boolean,
  p_note text,
  p_content_hash text
) returns boolean language plpgsql as $$
declare released tasks%rowtype;
begin
  update tasks set
    claimed_by = null, claimed_at = null, heartbeat_at = null,
    status = case when p_reopen then 'todo' else status end
  where id = p_task_id
    and claimed_by = p_expected_holder
    and ownership_version = p_expected_version
    and heartbeat_at is not distinct from p_expected_heartbeat
    and updated_at is not distinct from p_expected_updated_at
  returning * into released;
  if not found then return false; end if;

  insert into task_notes
    (task_id, actor_type, actor_id, kind, note, content_hash)
  values (released.id, p_actor_type, p_actor_id, 'handoff', p_note, p_content_hash)
  on conflict (task_id, content_hash) do nothing;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, released.project_id, released.id, p_actor_type, p_actor_id,
     'released', jsonb_build_object('reason', 'reconcile', 'reopened', p_reopen,
       'ownershipVersion', p_expected_version));
  return true;
end $$;

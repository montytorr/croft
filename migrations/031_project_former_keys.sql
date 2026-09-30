-- ===========================================================================
-- A project key change used to invalidate every ref already issued.
--
-- `PATCH /projects/{id}` accepts a new key and the API documents that this
-- "changes every task ref". It did, and nothing recorded what the project used
-- to be called, so CAI-42 written in a commit message, a PR title or another
-- agent's note stopped resolving. Those artefacts are immutable — a rename
-- cannot reach them — and refs are designed to escape into them.
--
-- The damage reached inside Croft too: bare refs in task bodies and notes are
-- linkified at render time against the list of live project keys, so an old
-- ref still looked like a ref, was still a link, and led nowhere. The memory
-- store broke its own cross-references.
--
-- This project has already answered this question twice, in the same
-- direction: `superseded_by` keeps a corrected claim findable AND marked
-- rather than overwriting it, and `external_ref` exists so a migrated task
-- keeps a pointer home. A ref orphaned by a rename is the same thing, produced
-- by this tracker rather than another one. So a rename is additive: the former
-- key is kept, old refs resolve, and the task says what it used to be called.
--
-- No tracker can rewrite a git history, so this is mitigation and not a cure.
-- The alternative — refusing to rename a key that has issued refs — is the
-- other honest answer, and is rejected only because renaming is a real need
-- and a redirect costs one table.
-- ===========================================================================

create table if not exists project_former_keys (
  owner_user_id uuid not null references app_users (id) on delete cascade,
  key           text not null,
  project_id    uuid not null references projects (id) on delete cascade,
  retired_at    timestamptz not null default now(),
  -- One former key resolves to at most one project, per owner. This is the
  -- constraint that keeps an old ref unambiguous, and it is why reusing a
  -- retired key for a different project has to be refused rather than allowed.
  primary key (owner_user_id, key),
  constraint project_former_keys_format check (key ~ '^[A-Z][A-Z0-9]{1,9}$')
);

create index if not exists project_former_keys_project_idx
  on project_former_keys (project_id);

-- ---------------------------------------------------------------------------
-- The rename itself, in one statement, because the update and the record of
-- what the key used to be must not be able to happen separately. Doing them as
-- two round trips means a failure between them either loses the alias — the
-- silence this migration exists to end — or writes a former key identical to
-- the live one, which would shadow it.
-- ---------------------------------------------------------------------------

create or replace function project_rename_key(p_project uuid, p_new_key text)
returns text
language plpgsql
as $$
declare
  v_owner uuid;
  v_old   text;
  v_taken uuid;
begin
  select owner_user_id, key into v_owner, v_old from projects where id = p_project;
  if v_owner is null then
    raise exception 'no such project' using errcode = 'P0002';
  end if;
  if v_old = p_new_key then
    return v_old;
  end if;

  -- A key retired by another project cannot be reused: every ref already
  -- issued under it would become ambiguous, which is worse than the rename
  -- being refused.
  select project_id into v_taken
    from project_former_keys
    where owner_user_id = v_owner and key = p_new_key;
  if v_taken is not null and v_taken <> p_project then
    raise exception 'key % is retired by another project', p_new_key
      using errcode = '23505';
  end if;

  update projects set key = p_new_key, updated_at = now() where id = p_project;

  -- A project reclaiming its own former key: that alias is the live key again,
  -- so it must stop being an alias.
  delete from project_former_keys where owner_user_id = v_owner and key = p_new_key;

  insert into project_former_keys (owner_user_id, key, project_id)
  values (v_owner, v_old, p_project)
  on conflict (owner_user_id, key)
    do update set project_id = excluded.project_id, retired_at = now();

  return v_old;
end;
$$;

-- ===========================================================================
-- Which project a repository is, rather than which project a path is.
--
-- The briefing resolved a working directory through ~/.croft/projects.json, a
-- per-machine map keyed on an absolute path. A path is where one machine keeps
-- a checkout; it changes under a second clone, a `mv` and a `git worktree`,
-- none of which change the repository. A worktree of this very repo resolved
-- to no project at all, which is the case that prompted this.
--
-- The remote is the same string in every clone and every worktree, and costs
-- one local git call to read — no network, which matters because the only
-- caller is a hook with a 4s budget and no way to recover from a stall.
--
-- Many-to-one, and deliberately NOT unique on (owner, remote): one repository
-- can hold several projects. That ambiguity is resolved by refusing to resolve
-- (see projectKeyFromRepoRows), which is better than picking a row and being
-- quietly wrong for months.
-- ===========================================================================

create table if not exists project_repos (
  project_id     uuid not null references projects (id) on delete cascade,
  owner_user_id  uuid not null references app_users (id) on delete cascade,
  remote         text not null,
  -- Survives the rename or org transfer that changes a remote URL. Never the
  -- primary key: a fork shares its root commit with upstream, and a shallow
  -- clone reports its graft boundary instead of the true root, so the value
  -- can be confidently wrong. A hint for repair, not an identity.
  root_commit    text,
  created_at     timestamptz not null default now(),
  primary key (project_id, remote)
);

-- Read on every session start and every file open, so this has to be an index
-- hit rather than a scan.
create index if not exists project_repos_remote_idx
  on project_repos (owner_user_id, remote);

create index if not exists project_repos_root_commit_idx
  on project_repos (owner_user_id, root_commit)
  where root_commit is not null;

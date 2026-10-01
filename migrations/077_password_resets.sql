-- 077: email-only password resets, and no administrator exception.
--
-- 1. password_reset_tokens. A reset is a single-use link emailed to the person
--    whose password it sets: an administrator can only ask for one to be sent
--    (purpose 'admin_reset', requested_by = the administrator), and anyone can
--    ask for their own from the sign-in page (purpose 'forgot'). The operator's
--    break-glass script (scripts/reset-password.mjs) writes an 'admin_reset'
--    with no requested_by. Only the sha256 of the token is stored; the token
--    itself exists in the email (or on the host's stdout) and nowhere else.
--
--    A new request invalidates the user's earlier unused tokens, so at most one
--    is ever live per user — the partial unique index makes that a fact rather
--    than a habit. "Invalidated" and "used" are the same stamp: either way the
--    link is dead.
--
-- 2. croft_subject_visible loses its admin branch. Until now an ACTIVE admin saw
--    a non-lab subject once its owner was gone (deactivated, deleted or null).
--    That made "disable the owner" a way to read their private work. Now a
--    private subject of a departed owner is invisible to everyone until the
--    owner is restored; a members subject stays visible to its members. A
--    private subject whose owner was hard-deleted stays hidden for good — the
--    database is the break-glass, and SECURITY.md says so.
--
--    Transformed from the definition actually installed, never re-copied from
--    076: a re-copied body silently reverts every change made since.

-- ---------------------------------------------------------------------------
-- 1. Reset tokens.
-- ---------------------------------------------------------------------------

create table password_reset_tokens (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references app_users(id) on delete cascade,
  token_hash   text        not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  requested_by uuid        references app_users(id) on delete set null,
  purpose      text        not null check (purpose in ('admin_reset', 'forgot')),
  expires_at   timestamptz not null default now() + interval '1 hour',
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);

create unique index password_reset_tokens_one_live_idx
  on password_reset_tokens (user_id) where used_at is null;

comment on table password_reset_tokens is
  'Single-use password reset links (077). token_hash is sha256(token) in hex; the token is only ever '
  'in the email, or on the host''s stdout for scripts/reset-password.mjs. used_at marks a token used '
  'or invalidated; at most one unused token per user.';

-- ---------------------------------------------------------------------------
-- 2. No administrator exception.
-- ---------------------------------------------------------------------------

do $migration$
declare
  fn regprocedure := to_regprocedure('croft_subject_visible(uuid, uuid)');
  definition text;
  updated text;
  admin_branch constant text :=
    '\s*or \(not croft_user_active\(s\.owner_user_id\)\s+'
    'and exists \(select 1 from app_users v\s+'
    'where v\.id = p_viewer\s+'
    'and v\.role = ''admin''\s+'
    'and v\.deleted_at is null\s+'
    'and coalesce\(v\.banned_until, ''-infinity''::timestamptz\) <= now\(\)\)\)';
  found int;
begin
  if fn is null then
    raise exception '077: croft_subject_visible(uuid, uuid) is not installed';
  end if;
  definition := pg_get_functiondef(fn);

  if definition not like '%app_users v%' and definition not like '%''admin''%' then
    raise notice '077: croft_subject_visible has no admin branch already; left as it is';
    return;
  end if;

  found := regexp_count(definition, admin_branch);
  if found <> 1 then
    raise exception '077: expected exactly one admin branch in croft_subject_visible, found %', found;
  end if;
  updated := regexp_replace(definition, admin_branch, '');

  -- The rule that stays, and nothing of the branch that went.
  if updated not like '%s.visibility = ''lab''%'
     or updated not like '%s.owner_user_id = p_viewer%'
     or updated not like '%s.visibility = ''members''%'
     or updated not like '%from subject_members m%'
     or updated not like '%p_viewer is not null%'
     or updated not like '%SECURITY DEFINER%'
     or updated not like '%search_path%' then
    raise exception '077: the rewrite of croft_subject_visible lost part of the rule';
  end if;
  if updated ~* '''admin''|croft_user_active|app_users' then
    raise exception '077: croft_subject_visible still refers to administrators or user state';
  end if;

  execute updated;
end
$migration$;

comment on function croft_subject_visible(uuid, uuid) is
  'Whether p_viewer may see subject p_subject: a lab subject, its owner, or a member of a members '
  'subject. No administrator exception (077): a private subject whose owner is gone is hidden from '
  'everyone until the owner is restored. False for a subject that does not exist and, for a non-lab '
  'subject, for a null viewer. The one place the rule lives.';

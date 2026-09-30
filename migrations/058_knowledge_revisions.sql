-- ===========================================================================
-- 058: a correction keeps what it corrected (CROFT-266)
--
-- `relearn` was a plain UPDATE. The previous title, body, labels and scope were
-- gone the moment it ran, `actor_id` went on naming whoever first wrote the
-- entry, and the feed credited every later correction to that original author.
-- A store whose whole job is to hold what we concluded could not say what it
-- used to conclude, or who changed its mind.
--
-- One row per replaced version, written by the API in the same transaction as
-- the edit. `revision` numbers versions from 1 — the version first written —
-- so the version on the live row is always max(revision) + 1, and the row with
-- revision N says who replaced version N, when, and why.
--
-- Not every PATCH is a new version. `verify` only confirms the text is still
-- true; recording a revision for it would bury the edits under confirmations.
-- The snapshot still carries `verified_at`, so what was confirmed when is
-- visible on the version it applied to.
--
-- Scope is kept as KEYS, not ids: a revision is a record of what the entry said
-- at the time, and the key is what it said.
-- ===========================================================================

create table if not exists knowledge_revisions (
  id              uuid primary key default gen_random_uuid(),
  knowledge_id    uuid not null references knowledge(id) on delete cascade,
  revision        integer not null check (revision >= 1),

  -- The version as it stood before this edit.
  title           text not null,
  body            text not null,
  labels          text[] not null default '{}',
  projects        text[] not null default '{}',
  entities        text[] not null default '{}',
  verified_at     timestamptz,
  superseded_by   uuid references knowledge(id) on delete set null,

  -- The edit that replaced it.
  change          text not null
                  check (change in ('relearned', 'rescoped', 'superseded', 'reinstated')),
  edited_by_type  text not null check (edited_by_type in ('human', 'agent')),
  edited_by       text,
  reason          text,
  edited_at       timestamptz not null default now(),

  unique (knowledge_id, revision)
);

create index if not exists knowledge_revisions_edited_idx
  on knowledge_revisions (edited_at desc);

comment on table knowledge_revisions is
  'Each replaced version of a knowledge entry. Revision N is version N as it stood, plus who replaced it, when and why. The live row is version max(revision)+1.';

-- ---------------------------------------------------------------------------
-- The feed: a correction is credited to whoever made it.
--
-- An entry that has never been revised keeps exactly the row it had, so the
-- history written before this migration reads as it did. One that has been
-- revised shows when it was first written and by whom, then one row per edit
-- carrying the editor and the title it was given.
--
-- Edited in place from the installed definition, not re-copied from an older
-- migration: see [[never-rebuild-a-sql-function-by-copying-an-older-migration-s-body]].
-- ---------------------------------------------------------------------------

do $migration$
declare
  fn oid;
  definition text;
  updated text;
  old_block constant text :=
    E'    from knowledge k\n'
    '    cross join want w, ceiling c\n'
    '    where k.updated_at < c.before\n'
    '      and (w.all_kinds or ''knowledge'' = any (w.kinds))\n'
    '  ),';
  new_block constant text :=
    E'    from knowledge k\n'
    '    cross join want w, ceiling c\n'
    '    where k.updated_at < c.before\n'
    '      and (w.all_kinds or ''knowledge'' = any (w.kinds))\n'
    '      and not exists (select 1 from knowledge_revisions r where r.knowledge_id = k.id)\n'
    '\n'
    '    union all\n'
    '\n'
    '    -- Revised (058): first written, by its author, under its first title.\n'
    '    select ''knowledge''::text, k.created_at, k.actor_id,\n'
    '           (select string_agg(pr.key, '','' order by pr.key)\n'
    '              from knowledge_projects kp join projects pr on pr.id = kp.project_id\n'
    '             where kp.knowledge_id = k.id),\n'
    '           k.slug, first.title, ''learned''\n'
    '    from knowledge k\n'
    '    join knowledge_revisions first on first.knowledge_id = k.id and first.revision = 1\n'
    '    cross join want w, ceiling c\n'
    '    where k.created_at < c.before\n'
    '      and (w.all_kinds or ''knowledge'' = any (w.kinds))\n'
    '\n'
    '    union all\n'
    '\n'
    '    -- Revised (058): each edit, by its editor, under the title it produced.\n'
    '    select ''knowledge''::text, r.edited_at, r.edited_by,\n'
    '           (select string_agg(pr.key, '','' order by pr.key)\n'
    '              from knowledge_projects kp join projects pr on pr.id = kp.project_id\n'
    '             where kp.knowledge_id = r.knowledge_id),\n'
    '           r.slug, r.title_after, r.change\n'
    '    from (\n'
    '      select kr.knowledge_id, kr.edited_at, kr.edited_by, kr.change, k.slug,\n'
    '             coalesce(lead(kr.title) over (partition by kr.knowledge_id order by kr.revision),\n'
    '                      k.title) as title_after\n'
    '      from knowledge_revisions kr\n'
    '      join knowledge k on k.id = kr.knowledge_id\n'
    '    ) r\n'
    '    cross join want w, ceiling c\n'
    '    where r.edited_at < c.before\n'
    '      and (w.all_kinds or ''knowledge'' = any (w.kinds))\n'
    '  ),';
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'activity_feed';

  if fn is null then
    raise exception 'activity_feed is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%knowledge_revisions%' then
    raise notice 'activity_feed already reads knowledge_revisions; nothing to do';
    return;
  end if;

  updated := replace(definition, old_block, new_block);
  if updated = definition then
    raise exception 'activity_feed: the knowledge_ block was not in the expected shape';
  end if;

  execute updated;
end
$migration$;

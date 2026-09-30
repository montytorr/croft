-- ===========================================================================
-- 053: whether the memory gave back the right thing, not just that it was asked
--
-- 024 made "was the memory consulted at all" answerable, and 025/027 aggregate
-- it. Two questions are still unanswerable in principle, and both are about
-- RECALL rather than volume.
--
-- 1. `search_events` stores `result_count` and never WHICH entries came back.
--    A widened search that found the right entry and a precise search that
--    found the wrong one are indistinguishable rows. One array on an insert
--    that already happens fixes that for good.
--
-- 2. Direct recall by slug — `croft know <slug>`, GET /api/v1/knowledge/[slug],
--    and every browser read — was not recorded anywhere. That is the one path
--    that IS "do we call knowledge when we need it", and it was the one path
--    with no instrumentation. The MISS is the valuable half: a miss on a
--    guessed slug is a dangling reference (CROFT-253) being followed live,
--    observed at the moment it fails rather than reconstructed later.
--
-- WHY A SEPARATE TABLE, AND NOT `search_events` WITH THE SLUG AS THE QUERY.
--
-- Reusing the table would have made direct reads show up in croft_memory_use
-- for free, which is genuinely what we want. It would also have corrupted the
-- three numbers that table already answers:
--
--   - `widened` is meaningless for a direct read — there is no second pass to
--     fall back to — so every read would be a permanent false negative
--     diluting the widening RATE, which is the headline recall signal 026
--     established.
--   - `zeroResults` means opposite things on the two paths. 026 is explicit
--     that an empty search result is NOT the miss signal, because two-pass
--     search practically never returns zero rows. For a direct read, zero rows
--     is EXACTLY the miss signal, and the most informative row we can record.
--     One column cannot carry both readings.
--   - `result_count` on a slug lookup is only ever 0 or 1, so pooling it with
--     search turns `searches` into a count of two different acts.
--
-- So: a separate table with its own columns, and croft_memory_use extended to
-- read both. The aggregate reports direct reads alongside searches instead of
-- inside them, and the one place where the two genuinely mean the same thing —
-- "did this actor ask the memory anything before filing work" — explicitly
-- unions them, because looking a fact up by name is checking.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Which entries a search actually returned.
-- ---------------------------------------------------------------------------

alter table search_events add column if not exists returned_slugs text[];

-- Nullable on purpose, and the distinction matters when reading old rows:
-- NULL is "recorded before this migration, we do not know", `{}` is "the
-- search ran and returned nothing". Defaulting to `{}` would have rewritten
-- every historical row into a claim nobody made.
comment on column search_events.returned_slugs is
  'The addressable ref of each row returned, in rank order. NULL means the event predates this column; {} means the search returned nothing.';

-- ---------------------------------------------------------------------------
-- 2. Direct recall by slug.
-- ---------------------------------------------------------------------------

create table if not exists knowledge_reads (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references app_users(id) on delete cascade,
  actor_id       text not null,
  -- The slug as it was looked up, normalised the same way the lookup
  -- normalises it, so a miss can be joined against `knowledge.slug` and
  -- against the dangling references in the corpus without guessing.
  slug           text not null,
  -- False is the row worth having: the memory was asked for a named fact by an
  -- agent that believed it existed, and did not have it.
  hit            boolean not null,
  created_at     timestamptz not null default now()
);

create index if not exists knowledge_reads_owner_idx
  on knowledge_reads (owner_user_id, created_at desc);
-- "Did this actor consult anything before filing that task" — the same shape
-- of lookup search_events_actor_idx exists for, now that a direct read counts
-- as consulting.
create index if not exists knowledge_reads_actor_idx
  on knowledge_reads (owner_user_id, actor_id, created_at desc);
-- Per-entry recall: which facts are read, which are dead weight, and which
-- slugs are repeatedly guessed at and missing.
create index if not exists knowledge_reads_slug_idx
  on knowledge_reads (slug, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Teach croft_memory_use about direct reads.
--
-- Transformed, not re-copied. croft_memory_use was written in 025, replaced in
-- 027, and had its owner predicates stripped in 048 when the workspace became
-- shared. Pasting the 027 body back would silently revive the tenancy filters
-- 048 removed, which is the exact failure mode 048's own header warns about.
-- See 051 for the house pattern: assert that each piece of text being replaced
-- was actually found, rather than trusting `replace` to have done anything.
-- ---------------------------------------------------------------------------

do $migration$
declare
  fn oid;
  definition text;
  updated text;
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'croft_memory_use';

  if fn is null then
    raise exception 'croft_memory_use is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%directReads%' then
    raise notice 'croft_memory_use already counts direct reads; nothing to do';
    return;
  end if;

  -- The reads CTE, inserted immediately before the final select. No owner
  -- predicate, deliberately: 048 removed every one of them from this function
  -- and a new one here would reintroduce a boundary the workspace no longer
  -- has.
  updated := replace(
    definition,
    E'select jsonb_build_object(',
    E',\n  reads as (\n'
    '    select r.* from knowledge_reads r, bounds b\n'
    '    where r.created_at >= b.window_start\n'
    '  )\n'
    'select jsonb_build_object('
  );
  -- `replace` is global; only the final select is preceded by a newline at
  -- column zero, but assert rather than trust it.
  if (length(updated) - length(definition)) <= 0 then
    raise exception 'croft_memory_use: the final select was not found';
  end if;

  -- Reported alongside the search numbers, never folded into them. A direct
  -- read is not a search and must not move `searches`, `widened` or
  -- `zeroResults`.
  updated := replace(
    updated,
    E'  ''tasksFiled'', (select count(*) from own o, bounds b where o.created_at >= b.window_start),',
    E'  ''directReads'', (select count(*) from reads),\n'
    '  -- A named fact an agent believed existed, and we did not have. This is a\n'
    '  -- dangling reference observed as it is followed.\n'
    '  ''directReadMisses'', (select count(*) from reads where not hit),\n'
    '  ''recentSlugMisses'', (\n'
    '    select coalesce(jsonb_agg(m.slug order by m.created_at desc), ''[]''::jsonb)\n'
    '    from (select slug, created_at from reads where not hit order by created_at desc limit 8) m\n'
    '  ),\n'
    '  ''tasksFiled'', (select count(*) from own o, bounds b where o.created_at >= b.window_start),'
  );

  -- The one place the two events mean the same thing: looking a fact up by
  -- name is consulting the memory, so work filed after one was not filed
  -- blind.
  updated := replace(
    updated,
    E'          and s.created_at between o.created_at - interval ''30 minutes'' and o.created_at\n'
    '      )\n'
    '  ),',
    E'          and s.created_at between o.created_at - interval ''30 minutes'' and o.created_at\n'
    '      )\n'
    '      and not exists (\n'
    '        select 1 from knowledge_reads r\n'
    '        where r.actor_id = o.actor_id\n'
    '          and r.created_at between o.created_at - interval ''30 minutes'' and o.created_at\n'
    '      )\n'
    '  ),'
  );

  if updated not like '%directReads%'
     or updated not like '%directReadMisses%'
     or updated not like '%recentSlugMisses%'
     or updated not like '%reads as (%'
     or updated not like '%select 1 from knowledge_reads r%' then
    raise exception 'croft_memory_use: rewrite did not produce all four changes';
  end if;

  execute updated;
end
$migration$;

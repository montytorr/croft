-- ===========================================================================
-- 066: an instance can carry its own name and accent (CROFT-306)
--
-- One machine now talks to several Crofts, and a browser tab titled "Croft"
-- with the same indigo stones says nothing about which one it is. The name
-- and the accent belong to the instance, not to a user, so this is one row
-- for the whole database rather than a column on app_users. The accent tints
-- the mark as well as the interface: the icon stays the croft, in a colour of
-- the instance's own.
--
-- In the database rather than the environment so an admin can change it from
-- Settings, and so a mirror that deploys upstream's image (Dispofi/croft)
-- needs no brand-specific build or deploy step.
-- ===========================================================================

create table if not exists instance_branding (
  -- Exactly one row: the key can only ever be true.
  id          boolean primary key default true check (id),
  name        text check (name is null or char_length(btrim(name)) between 1 and 60),
  -- Lower-case six-digit hex only: it is written into a stylesheet on every
  -- page, so the table refuses anything else even if a route forgets to.
  accent      text check (accent is null or accent ~ '^#[0-9a-f]{6}$'),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references app_users(id) on delete set null
);

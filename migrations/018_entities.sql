-- ===========================================================================
-- 018: entities — the scope between one project and everything
--
-- Knowledge could be filed against a project, or against nothing at all. The
-- gap between those showed up as soon as there was a real corpus to look at:
-- of 19 "global" facts, five were not global. A campaign id, a marketing-tool
-- convention and a subdomain finding were all true of one business and
-- meaningless to the rest of the work. They were filed global because there was
-- nowhere narrower that was not also wrong.
--
-- An entity is any grouping a fact can be true of. Deliberately many-to-many on
-- both sides rather than a tree: a project belongs to a business, but it also
-- sits on a stack and inside a subsystem, and a fact can be true for any of
-- those reasons. A strict parent would force a choice between them and be
-- wrong for whichever it did not pick. Only business entities are being seeded
-- now; the shape costs nothing extra and the others are one row each when they
-- earn their place.
--
-- Resolution for a directory becomes project ∪ entities-of-that-project ∪
-- global, and narrower wins: a project fact outranks an entity fact outranks a
-- global one. That is how "true for this business, except in that repo" gets said without
-- `superseded_by`, which claims something different -- that one fact replaced
-- another, rather than that one is more specific than another.
-- ===========================================================================

create table entities (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references app_users(id) on delete cascade,

  key           text not null,
  title         text not null,
  description   text not null default '',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint entities_key_shape check (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create unique index entities_owner_key_idx on entities (owner_user_id, key);

create trigger entities_touch before update on entities
  for each row execute function touch_updated_at();

comment on table entities is
  'A grouping a fact can be true of -- a business, a stack, a subsystem. Sits '
  'between one project and everything, and is many-to-many with both sides '
  'because a project belongs to more than one at a time.';

create table project_entities (
  project_id uuid not null references projects(id) on delete cascade,
  entity_id  uuid not null references entities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, entity_id)
);

create index project_entities_entity_idx on project_entities (entity_id);

create table knowledge_entities (
  knowledge_id uuid not null references knowledge(id) on delete cascade,
  entity_id    uuid not null references entities(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (knowledge_id, entity_id)
);

create index knowledge_entities_entity_idx on knowledge_entities (entity_id);

-- ---------------------------------------------------------------------------
-- No seed.
--
-- This migration once created three entities and mapped projects onto them by
-- matching the Linear team recorded in each project's description. That was one
-- workspace's own business split, and installing it gave every other workspace
-- three groupings named after somebody else's companies.
--
-- An entity is only ever worth what the person filing knowledge means by it, so
-- they are created where that is known: `croft entities`, or Settings.
-- ---------------------------------------------------------------------------

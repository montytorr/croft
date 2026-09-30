-- ===========================================================================
-- 068: browser pairing so a machine can get API keys for its own agents (CROFT-314)
--
-- Today only an administrator can mint a key, from Settings, for someone
-- else's agent. That is right for managing other people's credentials and
-- wrong for the common case: a person setting up their own laptop wants keys
-- for their own agents, and should not need an admin in the loop to get them.
--
-- This is the device-authorization-grant shape (RFC 8628) rather than
-- anything bespoke: a CLI with no browser of its own asks for a pairing,
-- shows the person a short code, and polls while they approve it on a device
-- that does have one. `device_code_hash` is what the CLI holds and what gets
-- exchanged back for keys; only its hash is stored, the same way an API key's
-- plaintext never is. `user_code` is what a human types or is shown, so it
-- has to stay short and unambiguous — the alphabet it is drawn from lives in
-- code, not here.
--
-- One row per attempt, not one row per device: approving mints keys and
-- consumes the row in the same beat, so a second poll (or a replayed one)
-- finds nothing left to redeem. `status` is the state machine —
-- pending → approved → consumed, or pending → denied, or pending → expired —
-- and the partial unique index below is what stops two *live* requests from
-- sharing a user code a person could be shown for the wrong one.
-- ===========================================================================

create table connect_requests (
  id                 uuid primary key default gen_random_uuid(),
  device_code_hash   text not null unique,
  user_code          text not null,
  host               text not null,
  runtimes           text[] not null,
  cli_version        text,
  client_address     text,
  status             text not null default 'pending'
                        check (status in ('pending', 'approved', 'denied', 'consumed', 'expired')),
  -- Who approved it, and what they approved: recorded even after the row
  -- moves to consumed, so the approval survives the redemption that follows
  -- it. `on delete cascade` matches how a deleted user's other credentials
  -- (api_keys) are handled — nothing is left pointing at a user who no
  -- longer exists.
  approved_by        uuid references app_users(id) on delete cascade,
  approved_runtimes  text[],
  decided_at         timestamptz,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now()
);

-- A code is only ever shown for one live request at a time. Denied,
-- consumed and expired rows keep their code — it is part of the history —
-- but stop reserving it, so the small alphabet does not run out.
create unique index connect_requests_user_code_live_idx
  on connect_requests(user_code) where status in ('pending', 'approved');

-- The sweep on create (below) covers the common case; this index is for
-- whatever eventually reaps rows this old regardless of status.
create index connect_requests_expires_at_idx on connect_requests(expires_at);

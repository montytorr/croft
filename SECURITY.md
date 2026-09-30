# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/montytorr/croft/security/advisories/new).
Please do not open a public issue for anything exploitable.

Croft is maintained in the open by one person, so there is no response-time
commitment. You will get an acknowledgement and, where a fix is warranted, a note when it
lands.

## What Croft is, in security terms

Croft is **one trusted shared workspace**. Every active user and valid agent key can read
and operate on the workspace's subjects, todos and projects. Human administrators alone can
add, disable and restore users, change roles, reset passwords, and issue or revoke other people's
agent keys. A signed-in member can pair keys for their own agents (below), and list or
revoke their own keys — never anyone else's. There is no public sign-up page.

It is also, deliberately, a thing agents write to unattended. That shapes what matters:

- **Agent keys are the identity.** `actor_id` comes from the key and is qualified with its
  owning user's display identity. Keys are stored as a sha256 hash — the plaintext is
  shown once, at creation, and never again — and each can be revoked without disturbing
  the others. Issue one per runtime; a shared key makes every write indistinguishable.
- **Pairing mints keys for whoever approves it.** `croft setup` asks `/api/v1/connect` for
  a code and the person approves `/connect/<code>` in a signed-in browser; an agent key
  cannot approve or deny (403). Device codes are stored as a sha256 hash, expire in ten
  minutes, and are redeemed once; both unauthenticated endpoints are rate-limited per
  address. A `maintenance` key releases anyone's claims, so only an administrator can
  approve one, and the role is checked again at minting. The risk is device-code phishing:
  a link someone else sends you would hand them keys to your agents, so the approval card
  says to approve only a `croft setup` you just ran, shows the host "as reported", and
  flags a request from a different address than yours.
- **Everyone can revoke their own keys.** **Your agent keys** (`/settings/keys`, backed by
  `GET /api/v1/me/keys` and `DELETE /api/v1/me/keys/{keyId}`) lists the signed-in person's
  keys — prefix, runtime, host, created and last used; never the hash or the key — and
  revokes them one at a time or a whole host at once. It is the administrator's revocation,
  scoped to the caller: a key that is someone else's is the same 404 as one that never
  existed. Like approval, it needs a person in a browser; an agent key gets 403, so a
  compromised key cannot list or revoke its siblings.
- **Sessions for the UI are opaque and revocable**, held server-side, not JWTs.
- **The database is not public.** It is reachable only from the private application
  network; the container runs read-only, as a non-root user, with capabilities dropped.
- **Attachments** are validated against an allowlist of types and a size limit, stored
  outside the web root, and served through short-lived signed URLs.

## Running it safely

- Keep `DATABASE_URL`, `CROFT_ATTACHMENT_SIGNING_KEY` and `CROFT_SECRET_KEY` server-side.
  `.env*` is gitignored except `.env.example`, and CI runs a secret scan on every push.
- The Cairn API key an administrator stores for push and sync is sealed with AES-256-GCM
  under `CROFT_SECRET_KEY` (derived from the signing key when unset) and never returned by
  the API. Rotating whichever key seals it makes it unreadable: store it again afterwards.
- The session briefing (`croft context --brief`) sends no working directory: the server
  never used it. `croft context` sends the working directory and the git remote, and every
  request carries the hostname, so a shared instance learns how every member's machine is
  laid out. `CROFT_SHARE_LOCATION=off` (environment or `~/.croft/env`) keeps all three on
  the machine; `croft map` and `--project` still route work to a project.
- The agent-files job `croft setup` installs overwrites the CLI, the session hook and the
  skill every 15 minutes (hourly on Linux). It syncs the tag of the release setup installed,
  never a branch, over https only; it fetches every file before writing any, and never
  replaces its own two scripts from the network. Following a branch takes an explicit
  `CROFT_RAW_BASE` on the installer, and the job line then says `--unpinned`. Skip the job
  with `croft setup --no-jobs`.
- Put it behind TLS. The included compose example assumes a proxy that terminates it.
- Revoke an agent's key the moment that agent is retired, and every key on a machine the
  moment it is lost — on **Your agent keys**, without waiting for an administrator. A revoked
  key is refused on its next request. Disable a departing user to invalidate their browser
  sessions and active keys together.
- Back up the database **and** the attachment tree. One without the other restores to
  something that looks intact and is not.

## Known limitations

- Failed logins are limited per address and per account, in memory: several replicas each
  keep their own count.
- Workspace isolation is not tenant isolation: a member who must not see another member's
  projects needs a separate Croft deployment.
- Subject write-ups, logs and todo bodies are rendered as markdown and shared with every
  workspace member. Do not admit identities that should not be trusted with that content.

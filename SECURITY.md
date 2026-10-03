# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/montytorr/croft/security/advisories/new).
Please do not open a public issue for anything exploitable.

Croft is maintained in the open by one person, so there is no response-time
commitment. You will get an acknowledgement and, where a fix is warranted, a note when it
lands.

## What Croft is, in security terms

Croft is **one trusted shared workspace**. Every active user and valid agent key can read
and operate on the workspace's subjects, todos and projects — except subjects their owner
has kept private or shared with named members (below). Human administrators alone can
add, disable and restore users, change roles, have a password reset link emailed to someone,
and list or revoke other people's agent keys. **No administrator can obtain someone else's
credentials**: nobody can mint a key for someone else, set their password, or change their
email (see Passwords below). A key is its holder's identity and reads everything they can; so
does a password. A signed-in member pairs keys for their own agents (below), and lists or
revokes their own — never anyone else's. There is no public sign-up page.

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
- **Passwords are reset by email only** (0.5.0). See below.
- **The database is not public.** It is reachable only from the private application
  network; the container runs read-only, as a non-root user, with capabilities dropped.
- **Attachments** are validated against an allowlist of types and a size limit, stored
  outside the web root, and served through short-lived signed URLs.

## Passwords

- **An administrator can only trigger a reset.** `POST /api/v1/users/{id}/password-reset`
  (a human administrator's browser session) emails the person a single-use link; the
  answer says only where it went, masked. The administrator never sees a password, a token
  or the link. Setting someone else's password (`POST /api/v1/users/{id}/password` with any
  id but your own) is refused with 403, and so is changing someone else's email
  (`PATCH /api/v1/users/{id}` with `email`): the email is where the links go, so changing it
  would be setting the password with extra steps. A user's initial email and password are
  set when they are created. Your own password is changed in Settings.
- **"Forgot your password?"** on the sign-in page (`POST /api/auth/forgot`) sends the same
  link. It answers `{ ok: true }` whether or not the address belongs to anyone, and looks it
  up after answering, so neither the answer nor its timing says which. It is limited per
  client address (5 per 15 minutes, 429) and per email address (3 an hour, silently: the same
  answer, nothing sent), so it cannot be used to flood an inbox.
- **The link** is `CROFT_BASE_URL/reset/<token>`: 256 random bits, stored as a sha256 hash,
  valid for one hour, redeemable once (`POST /api/auth/reset`, limited per address). A new
  link, a password change, or disabling the user invalidates every earlier one; only active
  users can redeem one. An unknown, used, expired or superseded link gets one answer, 400
  `invalid_token`. Redeeming it signs the person out everywhere (the session epoch moves and
  every browser session is deleted, as any password change does); agent keys are untouched.
- **Links are built from `CROFT_BASE_URL`, never from the request's Host header**, so a
  forged host cannot have someone's link point elsewhere (reset poisoning). Mail goes through
  Resend (`RESEND_API_KEY`, `CROFT_MAIL_FROM`); the key is never logged or sent to the
  browser. With any of the three unset, nothing is sent and nothing is created: the admin
  route answers 503 `mail_not_configured` and the sign-in page offers no forgot form. A send
  the provider refuses answers 502 `mail_send_failed`, and its link is invalidated.
- **Break-glass is the host, not the web.** An operator with a shell on the host runs
  `node scripts/reset-password.mjs <email>` (in the container:
  `docker exec -it <container> node scripts/reset-password.mjs <email>`; needs
  `DATABASE_URL` and `CROFT_BASE_URL`, or `--base-url`). It prints a one-time reset link —
  the same kind of token — to that shell's stdout and nowhere else. `npm run operator:create`
  still creates or updates an administrator from `CROFT_OPERATOR_*`. Both need what the
  database already gives: the web administrator role alone can never set or see a credential.

## Private and members-only subjects

A lab subject is visible to everyone, as it always was, and it is the default. A subject
can instead be **private** (its owner alone) or **members** (its owner and the people on
its members list). The rule:

- A viewer sees a subject when it is a lab subject, when they own it, or when it is a
  members subject and they are on its list. **There is no administrator exception** (removed
  in 0.5.0): an administrator does not see someone's private subject, not even once its owner
  is disabled — the role manages people and keys, not other people's work. While an owner is
  deactivated their private subjects are invisible to everyone and their members subjects
  stay visible to their members only, until the owner is restored. An agent key sees what
  its human sees.
- A todo inherits its subject's visibility, with everything hanging off it: notes,
  comments, attachments, activity (tombstones of deleted todos included), mentions it makes
  of other tasks, and dependencies. A task with no subject is visible to everyone.
- **Hidden is the same as missing.** A subject or todo you cannot see answers exactly as
  one that does not exist — the same `not_found`, the same message — on reads, on writes,
  and on every path that resolves a ref first (dependencies, duplicate-of, parent,
  Cairn links, attachments by id). Search, activity, labels, the brief, lab-project counts
  and the live-update pulse count and rank only what the viewer can see; the pulse the
  event stream sends is a sha256 hash of that viewer's fingerprint, never the counts.
- Writes on a non-lab subject and its todos are for those who can see it. Changing its
  visibility, members or owner is for the owner alone, with no administrator standing in:
  while the owner is gone nobody can change who sees it. A private or members subject must
  have an owner.
- **Publishing is one way.** `private` and `members` move freely between each other, and
  either can be published to the lab; a lab subject cannot be made private again (409
  `already_published`), because everyone may already have read it. Each change is written
  to the subject's log as a server-only `visibility` note.
- Pushing a todo of a non-lab subject to Cairn is refused (409 `subject_not_published`)
  unless forced (`croft push --force`): Cairn has its own audience, and Croft cannot take
  back what it sent.
- The rule lives in the database, in one place: `croft_subject_visible(subject, viewer)`,
  with `croft_task_visible` and `croft_visible_subjects` built on it (migration 076; 077
  removed the administrator branch). The
  search, activity, label and pulse functions filter through it inside their ranking,
  before any limit, so a filtered answer is never short and never tells an outsider how
  much was removed.

What this does **not** hide, by design:

- **Numbering gaps.** Subjects and todos are numbered workspace-wide (`S-12`, `CAI-42`). An
  outsider who sees S-11 and S-13 can infer that S-12 exists, and a new todo's number
  says how many tasks the project has ever had. Only the number leaks — never the title,
  owner or content.
- **Signed file URLs already issued.** Attachment links are signed for up to an hour.
  Removing someone from a members list, or making a subject private again, stops them
  opening its files through Croft at once, but a link they already hold keeps working
  until it expires — up to one hour.
- **Workspace-wide vocabularies.** Tag names, stage names and lab-project names are shared
  by everyone; a tag created on a private subject exists for the whole workspace.
- **Counts in refusals and admin screens.** An administrator's "in use" counts (a stage,
  tag or lab project that subjects still use, a person's open tasks) are workspace-wide;
  refusing to delete a task that still has children or dependants says how many, hidden
  ones included; and a project holding tasks you cannot see refuses to be deleted by you
  (deleting it would delete them), saying how many. They reveal a number, never a title
  or content.
- **Waiting on hidden work.** A task blocked by a todo you cannot see is still held back
  from `croft next`, though its dependency list shows you nothing.
- **The maintenance sweep.** An administrator's `maintenance` key releases quiet claims
  across the workspace, private todos included, and reports those by ref alone — not who
  held them or when they last moved.
- **Workspace-wide operations.** Archiving a project freezes every task in it, private
  todos included, until someone restores it; handing a disabled person's open tasks to
  someone else moves their private todos too, to someone who may not be able to see them.
- **Timing.** Changes that affect only what someone else can see do not move your pulse,
  but a request's latency is not constant-time.

## Running it safely

- Keep `DATABASE_URL`, `CROFT_ATTACHMENT_SIGNING_KEY` and `RESEND_API_KEY`
  server-side. A send-only (restricted) Resend key is enough: Croft only ever posts to `/emails`.
  `.env*` is gitignored except `.env.example`, and CI runs a secret scan on every push.
- Cairn handoff and sync use the agent machine's Cairn CLI and credentials. Croft stores
  no shared Cairn key and makes no server-side requests to Cairn. The agent reports linked
  task statuses through the same Croft visibility checks as other todo writes.
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

- Failed logins, forgot-password requests and reset attempts are limited per address (and
  per account or email address), in memory: several replicas each keep their own count.
- Workspace isolation is not tenant isolation: a member who must not see another member's
  projects needs a separate Croft deployment.
- **Orphaned private subjects stay hidden.** A private subject whose owner was hard-deleted
  from the database has no owner and no members, and so no viewer: it stays hidden for good.
  That is accepted. Disabling (the only removal the web offers) keeps the owner, so restoring
  them brings it back; past that, the break-glass is the database itself — an operator can
  give the subject a new owner (`update subjects set owner_user_id = ...`) or publish it.
- The web administrator role cannot read someone's private work: it cannot mint their key
  (since 0.4.2), set their password, change their email, or see their subjects once they are
  disabled (since 0.5.0). Whoever holds the database or a shell on the host still can — they
  can read the tables directly — so treat those as the higher privilege they are.
- Lab subject write-ups, logs and todo bodies are rendered as markdown and shared with every
  workspace member. Do not admit identities that should not be trusted with that content.
  Private and members-only subjects narrow who can read a subject, not who can reach the
  workspace: they are privacy between trusted colleagues, not tenant isolation.

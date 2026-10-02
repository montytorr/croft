# Croft

The lab board your agents and your people share: what you are exploring, what you proved, what
you rejected and why, and what you are building next.

A croft is a small tenanted farm, worked in strips. Croft is worked the same way: one instance per
working group, and every idea on it a strip of ground someone is trying.

## What it holds

- **Subjects** (`S-12`): a new technology to evaluate, a POC, an idea to build. Each one is a
  long-form markdown write-up that anyone can edit, an append-only log of what was found and
  tried, curated tags, an owner, and a conclusion.
- **Stages**: the pipeline a subject moves through, curated by an administrator. The defaults
  are to explore → exploring → done / rejected → to implement → implementing → internal testing →
  ready for rollout → rolled out. Every stage sits in one of four fixed categories (planned,
  active, completed, dropped). Entering a completed or dropped stage asks for a conclusion,
  because "we tried it and here is why not" is the most valuable thing a lab writes down.
- **Todos** (`T-41`): the work inside a subject. They behave exactly like tasks do in
  [Cairn](https://github.com/montytorr/cairn), which Croft is forked from: claims that expire,
  typed notes, checkpoints, and a resolution to close.

Humans and agents can do everything. People use the web app (list or board); agents use the
`croft` CLI and skill.

## With Cairn, or without it

Croft works on its own. When the same machine also runs Cairn, the two pair:

- **One session opener.** Croft does not install its own briefing hook when Cairn's is present.
  Cairn's briefing carries Croft's block instead, because two briefings competing for the top of
  a session is how both get skimmed.
- **One rule for which tool gets the work.** Exploring, evaluating or proving an idea goes in
  Croft. Changing a repository for real goes in Cairn.
- **Todos move across.** `croft push T-41 --to KEY` creates the Cairn task, labelled
  `croft:T-41`. From then on Cairn owns its status and Croft mirrors it read-only. When the Cairn
  task closes, its resolution is written into the subject's log.

## Running it locally

Requires Node 22+ and PostgreSQL 17+.

```bash
cp .env.example .env.local        # DATABASE_URL and the attachment signing key
npm install
npm run db:migrate
CROFT_OPERATOR_EMAIL=you@example.com CROFT_OPERATOR_PASSWORD='a-long-password' npm run operator:create
npm run dev
```

## Configuration

| Variable | |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string, for the app and `npm run db:migrate`. Required. |
| `CROFT_ATTACHMENT_SIGNING_KEY` | Signs the short-lived attachment URLs. Required. |
| `CROFT_SECRET_KEY` | 32 bytes (64 hex characters, or base64). Encrypts the Cairn API key the server stores for push and sync. Unset, it is derived from the signing key, and rotating that key then makes the stored Cairn key unreadable. |
| `CROFT_OPERATOR_EMAIL`, `_PASSWORD`, `_NAME` | The administrator `npm run operator:create` creates or updates. |
| `CROFT_BASE_URL` | The instance's public URL. Builds the links in password reset emails. |
| `RESEND_API_KEY`, `CROFT_MAIL_FROM` | Email through [Resend](https://resend.com), for password reset links (`CROFT_MAIL_FROM` e.g. `Croft <noreply@croft.example.com>`). Unset, nobody can be sent a reset link from the web; an operator on the host runs `node scripts/reset-password.mjs <email>`, which prints a one-time link. |
| `CROFT_MAIL_REPLY_TO` | Optional reply-to address on those emails. |

`.env.example` lists the rest (storage, proxy, bootstrap) with their defaults.

## CLI

Agents work the lab through `croft`, a single Node 22 file. Connect a machine once:

```bash
curl -fsSL https://raw.githubusercontent.com/montytorr/croft/main/install.sh | sh -s -- --url https://croft.example.com
# or, from a checkout:
CROFT_SETUP_SOURCE="$PWD" node cli/croft.mjs setup --url https://croft.example.com
```

`croft setup` pairs one key per runtime in the browser (Claude Code, Codex, OpenClaw),
installs the CLI to `~/.local/bin/croft`, copies the skill into `~/.claude/skills/croft` and
`~/.codex/skills/croft`, and adds the session briefing hook, unless Cairn's briefing already
carries it. It is safe to re-run; `--dry-run` prints the plan.

### What `croft setup` does

Only the runtimes it sets up get keys, hooks and skills: detected (`~/.claude`, `~/.codex`,
an OpenClaw gateway) or named with `--runtimes a,b`. Hermes Agent is never detected;
`hermes` on PATH gets a line saying how to add it (`--runtimes claude-code,hermes`), not a hook.

| Step | What it writes | Where | Skip | Undo |
|---|---|---|---|---|
| instance, keys | `CROFT_BASE_URL` and one `CROFT_API_KEY_<RUNTIME>` per runtime, paired in the browser | `~/.croft/env` (mode 600) | — | remove the lines; revoke the keys at `<instance>/settings/keys` |
| release | the release matching the CLI's version (or `CROFT_SETUP_SOURCE`) | `~/.croft/releases/<version>` | — | `rm -r` it |
| cli | `croft` | `~/.local/bin/croft` | — | `rm ~/.local/bin/croft` |
| skill | the Croft skill, per runtime set up | `~/.claude/skills/croft`, `~/.codex/skills/croft` | `--no-skill` | `rm -r` the folder |
| hooks | the session briefing hook, per runtime set up (none where Cairn's briefing already carries Croft's) | `~/.claude/settings.json`, `~/.codex/hooks.json`, OpenClaw's hook link; `~/.croft/hooks` | `--no-hooks` | delete the entries naming `~/.croft/hooks` |
| jobs | `agent-files`, which keeps the CLI, hook and skill equal to the installed release's tag every 15 minutes on macOS, hourly on Linux, for the runtimes set up; `reconcile` with `--maintenance` | a LaunchAgent on macOS, a crontab on Linux | `--no-jobs` | `node ~/.croft/releases/<version>/scripts/install-cron.mjs --remove --only agent-files` |

What it never does: wire a runtime it did not set up (Hermes included), follow a branch, or
replace the job's own scripts from the network. Every line it prints starts with `✓` (done),
`–` (unchanged or skipped, with the reason and how to change it) or `!` (needs you), and it
ends with the next step and the undo commands above.

```bash
croft check "<question>"                        # what the lab already found
croft subject add|list|show|edit|stage|note|tag|todo …
croft claim|note|checkpoint|done T-41 …         # todos are tasks
croft push T-41 --to KEY  /  croft sync         # hand over to Cairn, pull status back
croft context --brief                           # the lab in five lines
```

`croft --help` lists every verb; [`AGENTS.md`](./AGENTS.md) is how agents are expected to
use them, and [`docs/openclaw.md`](./docs/openclaw.md) covers OpenClaw.

### Cairn connection and scheduled maintenance

An administrator connects the server in **Settings → Cairn connection**: enter the Cairn
URL, choose **Connect with Cairn**, then open **Approve in Cairn**. Approve the `croft`
key there and leave the Croft settings tab open until it confirms the connection.
The key stays on the server, encrypted at rest. A manually issued key can still be entered
instead. **Sync now** checks the linked todos the caller can see; completed Cairn tasks
close their Croft todos and leave one outcome in the subject log. Private subjects keep
their existing visibility restrictions.

For an unattended server, pair an administrator's `maintenance` key through
`croft setup --maintenance` before installing jobs. The installer can schedule reconciliation every
30 minutes and server sync every 15 minutes:

```bash
node scripts/install-cron.mjs --only reconcile,sync             # review the schedule
node scripts/install-cron.mjs --install --only reconcile,sync   # activate it
node scripts/install-cron.mjs --run sync                        # run the installed job now
node scripts/install-cron.mjs --remove --only reconcile,sync    # undo
```

On Linux, jobs live in the user's managed crontab and write to `/var/log/croft-reconcile.log`
and `/var/log/croft-sync.log`; use `CROFT_LOG_DIR` for a user-writable location. Existing
backup and agent-file jobs are preserved. `sync` requires a current CLI and uses
`--server-only`, so a missing server connection fails without using machine-local Cairn
credentials. Any unread linked task in a server sync makes the CLI exit nonzero while retaining the full
report. Ordinary `croft sync` still supports the local CLI fallback.

## Licence

Sustainable Use License (fair-code), as Cairn. Code inherited from Cairn up to v0.5.1 remains
available under MIT; see `LICENSE-MIT-HISTORY`.

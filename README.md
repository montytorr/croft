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

## Working with a tracker

Croft holds lab work and nothing else: subjects and their todos, worked in Croft (`claim`,
`note`, `done`). It is not a general task tracker, and it does not need one. Where a team also
keeps its committed work in a task tracker (e.g. Cairn or GitHub), a todo that becomes real work
leaves the lab:

- **`croft handoff T-41`** files it in the tracker through an adapter and links the two. The
  tracker and target default to the subject's lab project (set in Settings: a tracker name and a
  target in it, such as a project key or `owner/repo`); `--tracker` and `--to` say it by hand, and
  `--link REF` records a task you made yourself, for any tracker. The adapter uses that tool's own
  CLI and sign-in on the agent machine. Croft stores no credential for it and never calls it from
  the server.
- **From then on the tracker owns the status.** Croft shows it read-only and refuses to claim or
  close the todo (`handed_off`). `croft handoff T-41 --undo` takes it back.
- **`croft sync`** reads each handed-off todo's status back through its adapter and, when the task
  closes, writes the outcome into the subject's log once. Todos of a tracker with no adapter on
  that machine are reported and skipped.
- A todo of a private or members subject is not handed off without `--force`: a tracker has no
  notion of who may see what.

Tracker adapters (`cairn`, and `github` via `gh`) live in one delimited section of `cli/croft.mjs`;
supporting another tracker means adding one there.

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
`~/.codex/skills/croft`, and adds the session briefing hook. It is safe to re-run; `--dry-run` prints the plan.

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
| hooks | the session briefing hook, per runtime set up | `~/.claude/settings.json`, `~/.codex/hooks.json`, OpenClaw's hook link; `~/.croft/hooks` | `--no-hooks` | delete the entries naming `~/.croft/hooks` |
| jobs | `agent-files`, which keeps the CLI, hook and skill equal to the installed release's tag every 15 minutes on macOS, hourly on Linux, for the runtimes set up; `reconcile` with `--maintenance` | a LaunchAgent on macOS, a crontab on Linux | `--no-jobs` | `node ~/.croft/releases/<version>/scripts/install-cron.mjs --remove --only agent-files` |

What it never does: wire a runtime it did not set up (Hermes included), follow a branch, or
replace the job's own scripts from the network. Every line it prints starts with `✓` (done),
`–` (unchanged or skipped, with the reason and how to change it) or `!` (needs you), and it
ends with the next step and the undo commands above.

```bash
croft check "<question>"                        # what the lab already found
croft subject add|list|show|edit|stage|note|tag|todo …
croft claim|note|checkpoint|done T-41 …         # todos are tasks
croft handoff T-41  /  croft sync               # hand over to a task tracker, pull status back
croft context --brief                           # the lab in five lines
```

`croft --help` lists the lab verbs, `croft help --all` the rest of the todo verbs; [`AGENTS.md`](./AGENTS.md) is how agents are expected to
use them, and [`docs/openclaw.md`](./docs/openclaw.md) covers OpenClaw.

## Licence

Sustainable Use License (fair-code), as Cairn. Code inherited from Cairn up to v0.5.1 remains
available under MIT; see `LICENSE-MIT-HISTORY`.

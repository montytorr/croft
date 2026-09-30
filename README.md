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
| `CROFT_BASE_URL` | The instance's public URL. |

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

```bash
croft check "<question>"                        # what the lab already found
croft subject add|list|show|edit|stage|note|tag|todo …
croft claim|note|checkpoint|done T-41 …         # todos are tasks
croft push T-41 --to KEY  /  croft sync         # hand over to Cairn, pull status back
croft context --brief                           # the lab in five lines
```

`croft --help` lists every verb; [`AGENTS.md`](./AGENTS.md) is how agents are expected to
use them, and [`docs/openclaw.md`](./docs/openclaw.md) covers OpenClaw.

## Licence

Sustainable Use License (fair-code), as Cairn. Code inherited from Cairn up to v0.5.1 remains
available under MIT; see `LICENSE-MIT-HISTORY`.

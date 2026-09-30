# Croft on OpenClaw

OpenClaw gets Croft the way Claude Code and Codex do: a short lab briefing at the start of
each session, the skill, and a key of its own. Croft records no sessions and keeps no
memory, so there is nothing else to wire.

## The briefing hook

`hooks/openclaw/croft-briefing/` is a standard OpenClaw hook (`HOOK.md` + `handler.ts`).
OpenClaw has no session-start event that returns text, so it listens on `agent:bootstrap`
and adds one bootstrap file, `CROFT.md`:

```markdown
## Croft — the lab
Exploring or proving an idea → croft check first; changing a repo for real → a Cairn task (croft push).

<croft context --brief for the workspace: subjects per stage, yours in flight — five lines at most>
```

It runs `croft context --brief --cwd <workspaceDir>` as `CROFT_AGENT=openclaw` with a
3 second deadline (`CROFT_HOOK_TIMEOUT_MS`). If the CLI is missing, slow or failing, the
rule is injected alone; if anything else goes wrong, the session starts as if the hook
were not there. `CROFT_CLI` points it at a `croft` that is not on the gateway's PATH.

### Installing it

Run as the user the gateway runs as:

```bash
croft setup --url https://your-croft     # key, skill and hook together
node scripts/install-hooks.mjs           # the hook alone; --dry-run prints the plan
```

Both link only for an account that runs a gateway: its OpenClaw config
(`~/.openclaw/openclaw.json`, or `OPENCLAW_CONFIG_PATH`) sets `gateway.mode` or
`gateway.port`, agents or channels. A global install puts `openclaw` on every account's
PATH, and another account may hold only a client config; linking from there would leave
the real gateway unbriefed, so it is skipped and says why. `--openclaw` links anyway, for a
gateway not configured yet; `CROFT_OPENCLAW_BIN` names an `openclaw` not on PATH.

The installer copies the hook to `~/.croft/hooks/openclaw/croft-briefing` and runs:

```bash
openclaw hooks install --link ~/.croft/hooks/openclaw/croft-briefing --force
```

Then **restart the gateway**: OpenClaw loads hooks only when it starts. (An OpenClaw too old
for `--force` gets the same command without it.) The `agent-files` job that `croft setup`
installs keeps that copy current; a changed handler loads on the next restart.

Check it after the restart: `openclaw hooks list --json` shows `croft-briefing` loadable
and enabled, and the next session's first turn has a `CROFT.md` section.

### Where a hook has to live

OpenClaw discovers directory hooks only in `<workspace>/hooks/`, `~/.openclaw/hooks/`,
`hooks.internal.load.extraDirs` (what `hooks install --link` writes), plugins and its own
bundle. A hook anywhere else is enabled in config and never loaded, without an error; and
`hooks.path` is the webhook URL path, not a hook directory. That is why the copy lives at a
fixed path under `~/.croft` and is linked by OpenClaw's own command.

## With Cairn on the same gateway

When Cairn's `cairn-briefing` hook is enabled, Cairn's briefing carries Croft's block, and
two briefings competing for the top of every session is how both get skimmed. So the
installer does not link `croft-briefing` there and prints `briefing: carried by Cairn`; if
it is already linked, it says to disable it (`hooks.internal.entries.croft-briefing.enabled:
false`).

## Identity and the skill

- **Key:** OpenClaw gets its own `CROFT_API_KEY_OPENCLAW` in `~/.croft/env`. `croft setup`
  pairs it wherever it detects a gateway (or with `--runtimes openclaw`). Without one,
  OpenClaw's writes are filed under whichever runtime owns the key it borrows.
- **Agent name:** set `CROFT_AGENT=openclaw` where the gateway starts, so the agent's own
  `croft` calls pick that key. The hook sets it for its own call.
- **Skill:** `croft setup` copies `skills/croft` into `$CLAWD_HOME/skills/` when
  `CLAWD_HOME` is set; otherwise copy it into the workspace's skills directory yourself.

## The workspace AGENTS.md

The hook carries the rule, but `AGENTS.md` is what an OpenClaw agent reads as policy. Keep
one short block there that agrees with the skill, rather than restating the CLI:

````markdown
## Croft — the lab
Before evaluating, prototyping or reading up on anything: `croft check "<subject>"`, and
`croft subject show S-n` the hits that matter — the lab may already have concluded.
File a subject for what is new, break it into todos, log findings and dead ends
(`--kind attempt`), and conclude it: completed and dropped stages need `--conclusion`.
`claim` exiting 9 means another agent holds it: pick other work.
Committed work on a real repository belongs in Cairn: `croft push T-n --to <KEY>`.
The skill has the full lifecycle; `croft --help` has every verb.
````

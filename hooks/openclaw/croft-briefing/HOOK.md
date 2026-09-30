---
name: croft-briefing
description: "Inject Croft's one rule and a short `croft context --brief` lab briefing at agent bootstrap"
homepage: https://github.com/montytorr/croft/blob/main/docs/openclaw.md
metadata: { "openclaw": { "events": ["agent:bootstrap"] } }
---

# Croft briefing

Puts the Croft lab in front of every OpenClaw agent session, the way Claude Code and Codex
get it from their `SessionStart` hook.

## What It Does

- Listens for `agent:bootstrap`.
- Runs `croft context --brief --cwd <workspaceDir>` with `CROFT_AGENT=openclaw` (unless
  already set) and a 3 second deadline.
- Adds one bootstrap file, `CROFT.md`: the rule (exploring or proving an idea → `croft check`
  first; changing a repo for real → a Cairn task via `croft push`) followed by the brief
  (subjects per stage, and yours in flight — five lines at most).
- Fails open. If the CLI is missing, slow or errors, the rule is injected alone; if
  anything else goes wrong, the session starts exactly as it would have without this hook.

## When it is not installed

If Cairn's `cairn-briefing` hook is linked on this gateway, Cairn's briefing carries Croft's
block and `scripts/install-hooks.mjs` does not link this one ("briefing: carried by Cairn").

## Requirements

- The `croft` CLI on the gateway's PATH, or `CROFT_CLI` set to its absolute path.
- A Croft key for OpenClaw in `~/.croft/env` (`CROFT_API_KEY_OPENCLAW`, or the plain
  `CROFT_API_KEY`). `croft setup` pairs it.

## Configuration

Install it by linking, so upgrades to the linked copy take effect without reinstalling:

```bash
openclaw hooks install --link ~/.croft/hooks/openclaw/croft-briefing --force
# then restart the gateway
```

`croft setup` (or `node scripts/install-hooks.mjs` in the Croft repository) copies this
directory to `~/.croft/hooks/openclaw/croft-briefing` and runs that command for you when
`openclaw` is on PATH and this account runs the gateway. `scripts/sync-agent-files.mjs`
keeps the copy current.

Environment: `CROFT_CLI` (default `croft`), `CROFT_HOOK_TIMEOUT_MS` (default 3000).

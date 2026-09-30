#!/usr/bin/env node
/**
 * Wires Croft's one hook into the agent runtimes on this machine:
 *
 *   session start  -> inject the lab briefing (`croft context --brief`)
 *
 * Croft records no sessions — Cairn does — so there is no session-end hook,
 * and the Stop/SessionEnd/PreCompact/per-Read entries older installs wrote are
 * taken out again (only this installer's own; anyone else's are left alone).
 *
 * Yields to Cairn. Where Cairn's own SessionStart hook is installed (an entry
 * tagged "cairn-memory": true, or OpenClaw's cairn-briefing hook linked),
 * Cairn's briefing already carries Croft's block, and a second briefing
 * competing for the top of every session is how both get skimmed. So for that
 * runtime Croft's hook is not installed (and a previous one is removed), and
 * this prints "briefing: carried by Cairn". A Cairn whose installed briefing
 * script predates Croft's block is not yielded to: Croft briefs on its own and
 * says to re-run once Cairn is upgraded.
 *
 * Idempotent: run it again after an upgrade and it replaces its own entries
 * without touching anyone else's. Every entry it owns is tagged, and tagging
 * is how it knows what is safe to replace.
 *
 * Usage: node scripts/install-hooks.mjs [--dry-run] [--openclaw]
 *
 * `croft setup` runs this for you, alongside pairing keys and copying the
 * skill; run it by hand only to re-wire the hooks on their own.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DRY = process.argv.includes('--dry-run')
/** Link the OpenClaw hook even where this user has no OpenClaw config yet. */
const FORCE_OPENCLAW = process.argv.includes('--openclaw')
const HOME = homedir()
const REPO = dirname(import.meta.dirname)

const CONTEXT = join(HOME, '.croft', 'hooks', 'croft-context.mjs')
/** Scripts older installs copied beside it, removed now that nothing runs them. */
const RETIRED_SCRIPTS = ['croft-session-end.mjs', 'croft-learn-nudge.mjs']

/** Marks the entries this installer owns, so re-running replaces rather than duplicates. */
const TAG = 'croft-memory'
/** Marks Cairn's entries. Where its SessionStart hook is, Cairn carries Croft's briefing. */
const CAIRN_TAG = 'cairn-memory'
const CARRIED = 'briefing: carried by Cairn'

const log = (...a) => console.log(...a)

/**
 * The hook set, in a form that compares.
 *
 * Two files can hold the same hooks and different bytes: JSON.stringify emits
 * keys in insertion order, so rebuilding an entry moves `croft-memory` from
 * after `timeout` to before it, and a file without a trailing newline gains
 * one. Nothing about the configuration changed; every byte of it moved.
 *
 * That is not cosmetic for Codex. It refuses to run a hook whose entry does
 * not match a `trusted_hash` under `[hooks.state]` in config.toml, so a
 * rewrite that changes nothing still takes its memory offline until somebody
 * re-trusts each entry by hand. CROFT-167 was that failure, found the slow
 * way: the key worked, the scripts worked when run directly, and only the host
 * config was wrong.
 *
 * So: canonicalise, and do not write a file that already says this.
 */
const canonical = (settings) =>
  JSON.stringify(
    Object.entries(settings?.hooks ?? {})
      .map(([event, groups]) => [
        event,
        (groups ?? [])
          .map((g) => [
            g.matcher ?? null,
            (g.hooks ?? []).map((h) => Object.entries(h).sort(([a], [b]) => (a < b ? -1 : 1))),
          ])
          .sort(),
      ])
      .sort(),
  )

const writeJson = (path, value, before) => {
  if (canonical(before) === canonical(value)) {
    log(`  ${path} — unchanged`)
    return false
  }
  if (DRY) {
    log(`  would write ${path}`)
    return true
  }
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) copyFileSync(path, `${path}.bak-croft`)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return true
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * A hooks file this installer is about to rewrite: `{}` when there is none,
 * the parsed object, or an `error` when it cannot be read as one.
 *
 * `readJson`'s "anything unreadable is empty" is right for a config it only
 * inspects, and wrong for one it writes back: a settings.json with a trailing
 * comma read as `{}` came back holding Croft's hook and nothing else — every
 * permission, model and other hook in it gone. So a file that will not parse
 * is left exactly as it is, and the run says so and fails.
 */
const readHooksFile = (path) => {
  if (!existsSync(path)) return { value: {} }
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { error: `not valid JSON (${error.message})` }
  }
  const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  if (!isObject(value)) return { error: 'not a JSON object' }
  if (value.hooks != null && !isObject(value.hooks)) return { error: '"hooks" is not an object' }
  const bad = Object.entries(value.hooks ?? {}).find(([, groups]) => !Array.isArray(groups))
  if (bad) return { error: `"hooks.${bad[0]}" is not a list` }
  return { value }
}

const refuse = (runtime, path, error) => {
  console.error(`  ${runtime}: ${path} is ${error} — left untouched; fix it and re-run`)
  process.exitCode = 1
}

// --- the hook scripts themselves -------------------------------------------

const installScripts = () => {
  if (DRY) return log(`  would copy the hook into ${dirname(CONTEXT)}`)
  mkdirSync(dirname(CONTEXT), { recursive: true })
  copyFileSync(join(REPO, 'hooks', 'croft-context.mjs'), CONTEXT)
  for (const name of RETIRED_SCRIPTS) rmSync(join(dirname(CONTEXT), name), { force: true })
  log(`  script -> ${CONTEXT}`)
}

/**
 * An entry this installer owns.
 *
 * The tag alone is not enough. Hooks installed by hand, or by a version of
 * this script from before the tag existed, carry no tag and are invisible to
 * a filter that only looks for one -- so re-running appends a second copy
 * instead of replacing the first. That is not a cosmetic duplicate: the
 * session recorder makes a model call, and two of them fire per event.
 *
 * Found on a machine whose Claude hooks predated the tag, where the install
 * this comment was written for would have doubled every one of them.
 *
 * So recognise the script by NAME. Not by absolute path: an entry written when
 * the scripts lived somewhere else -- a different home, a checkout, a copy
 * under /opt -- still invokes the same files, and matching the full path
 * would miss exactly the stale entry that most needs replacing. The retired
 * script names stay in the list so their old entries are still recognised.
 */
const SCRIPT_NAMES = ['croft-context.mjs', 'croft-session-end.mjs', 'croft-learn-nudge.mjs']

const isMine = (hook) =>
  Boolean(hook?.[TAG]) ||
  (typeof hook?.command === 'string' && SCRIPT_NAMES.some((n) => hook.command.includes(n)))

/**
 * Take this installer's entries out of one event, and nothing else.
 *
 * `replace` below drops a whole group when any hook in it is ours, which is
 * right when the group is about to be rewritten and wrong for a removal: a
 * group can hold someone else's hook beside ours. So strip hook by hook, drop
 * only the groups this leaves empty, and the event key only when nothing is
 * left under it. Idempotent: an event with nothing of ours is untouched.
 */
const strip = (hooks, event) => {
  if (!Array.isArray(hooks[event])) return false
  let removed = false
  const groups = hooks[event]
    .map((g) => {
      const kept = (g.hooks ?? []).filter((h) => !isMine(h))
      if (kept.length === (g.hooks ?? []).length) return g
      removed = true
      return kept.length > 0 ? { ...g, hooks: kept } : null
    })
    .filter(Boolean)
  if (!removed) return false
  if (groups.length > 0) hooks[event] = groups
  else delete hooks[event]
  return true
}

/** Every hook in a file that is not this installer's, as `event: command`. */
const foreignHooks = (hooks) =>
  Object.entries(hooks ?? {}).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((g) =>
      (g.hooks ?? []).filter((h) => !isMine(h)).map((h) => ({ event, command: String(h.command ?? '?') })),
    ),
  )

/**
 * Cairn's SessionStart hook, by its tag or, for one installed before the tag,
 * by its script's name — the same two ways Cairn's installer knows its own.
 */
const isCairnHook = (hook) =>
  Boolean(hook?.[CAIRN_TAG]) || (typeof hook?.command === 'string' && hook.command.includes('cairn-context.mjs'))

/**
 * Whether the Cairn script a hook runs carries Croft's block. Cairn gained it
 * in the release that added the Croft sibling line; a Cairn briefing from
 * before that is tagged exactly the same, and yielding to it would leave the
 * session with no lab briefing at all. The script is read where the entry
 * says it is; one this cannot read gets the benefit of the doubt.
 */
const carriesCroft = (hook) => {
  const script = typeof hook?.command === 'string' ? hook.command.match(/(\S*cairn-context\.mjs)/)?.[1] : null
  if (!script) return true
  const path = script.replace(/^["']/, '').replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, HOME)
  try {
    return /croft/i.test(readFileSync(path, 'utf8'))
  } catch {
    return true
  }
}

/**
 * Cairn's briefing in one list of hooks: 'carries' (Croft stays out),
 * 'predates' (Cairn is there but too old to carry Croft's block), or null.
 */
const cairnBriefing = (hooks) => {
  const cairn = hooks.filter(isCairnHook)
  if (!cairn.length) return null
  return cairn.some(carriesCroft) ? 'carries' : 'predates'
}

const cairnBriefs = (hooks, event = 'SessionStart') =>
  cairnBriefing((Array.isArray(hooks?.[event]) ? hooks[event] : []).flatMap((g) => g?.hooks ?? []))

const PREDATES = "Cairn's briefing here predates Croft's block — Croft briefs on its own; after upgrading Cairn, re-run `croft setup`"

/** Events older installs of this script wrote to, and that it now only cleans. */
const RETIRED_EVENTS = ['PreToolUse', 'SessionEnd', 'PreCompact', 'Stop']

const isSafeHookCli = (value) => /^[A-Za-z0-9_./:+-]+$/.test(value)

const canonicalHermesHooks = (hooks) =>
  JSON.stringify(
    Object.entries(hooks ?? {})
      .map(([event, entries]) => [
        event,
        (Array.isArray(entries) ? entries : [])
          .map((entry) => Object.entries(entry ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)))
          .sort(),
      ])
      .sort(),
  )

// --- Claude Code ------------------------------------------------------------

const installClaude = () => {
  const path = join(HOME, '.claude', 'settings.json')
  if (!existsSync(path)) return log('  no ~/.claude/settings.json — skipped')

  // Read twice: `settings` is mutated below, so the second copy is the only
  // record of what the file said before this run.
  const read = readHooksFile(path)
  if (read.error) return refuse('claude', path, read.error)
  const before = read.value
  const settings = structuredClone(read.value)
  settings.hooks ??= {}

  const retired = RETIRED_EVENTS.filter((event) => strip(settings.hooks, event))
  const cairn = cairnBriefs(settings.hooks)
  const carried = cairn === 'carries'
  if (carried) {
    strip(settings.hooks, 'SessionStart')
  } else {
    const groups = (settings.hooks.SessionStart ?? []).filter((g) => !(g.hooks ?? []).some(isMine))
    groups.push({
      matcher: 'startup|resume|clear|compact',
      hooks: [{ type: 'command', command: `node ${CONTEXT}`, [TAG]: true, timeout: 10 }],
    })
    settings.hooks.SessionStart = groups
  }

  const wrote = writeJson(path, settings, before)
  if (carried) log(`  claude: ${CARRIED}`)
  else if (cairn === 'predates') log(`  claude: ${PREDATES}`)
  if (!carried && wrote) log('  claude: SessionStart (lab briefing)')
  if (wrote && retired.length) log(`  claude: removed Croft's old ${retired.join(', ')} hook(s)`)
}

// --- Codex ------------------------------------------------------------------

/**
 * Codex shares Claude Code's wire format exactly, so the same script serves it.
 * Every handler has to be trusted in config.toml before it runs, which this
 * cannot do for you — and why `writeJson` never rewrites a file whose hooks
 * already say this (see `canonical`).
 */
const installCodex = () => {
  const path = join(HOME, '.codex', 'hooks.json')
  if (!existsSync(join(HOME, '.codex'))) return log('  no ~/.codex — skipped')

  const read = readHooksFile(path)
  if (read.error) return refuse('codex', path, read.error)
  const before = read.value
  const config = structuredClone(read.value)
  config.hooks ??= {}

  // CROFT_AGENT names the runtime, and the CLI picks the matching key out of
  // ~/.croft/env. Without it every runtime on a machine shares one key, and
  // the key is the identity.
  const env = 'CROFT_AGENT=codex CROFT_PLATFORM=codex'

  const retired = RETIRED_EVENTS.filter((event) => strip(config.hooks, event))
  const cairn = cairnBriefs(config.hooks)
  const carried = cairn === 'carries'
  if (carried) {
    strip(config.hooks, 'SessionStart')
  } else {
    const groups = (config.hooks.SessionStart ?? []).filter((g) => !(g.hooks ?? []).some(isMine))
    groups.push({
      matcher: 'startup|resume|clear',
      hooks: [{ type: 'command', command: `${env} node ${CONTEXT}`, [TAG]: true, timeout: 10 }],
    })
    config.hooks.SessionStart = groups
  }

  // The trust warning is printed only when the file actually moved. Printed
  // every run it is wallpaper, and the one run where it matters reads the same
  // as the twenty where it did not.
  const wrote = writeJson(path, config, before)
  if (carried) log(`  codex: ${CARRIED}`)
  else if (cairn === 'predates') log(`  codex: ${PREDATES}`)
  if (wrote) {
    if (!carried) log('  codex: SessionStart (lab briefing)')
    if (retired.length) log(`  codex: removed Croft's old ${retired.join(', ')} hook(s)`)
    if (!carried) {
      log('  codex: the entry must be trusted on next launch — [hooks.state] in config.toml')
      log('  codex: needs CROFT_API_KEY_CODEX (`croft setup` pairs one), or it writes as')
      log('         whoever owns the plain CROFT_API_KEY')
    }
  }

  // Said, never done. These are somebody else's hooks, and this installer has
  // no business removing them — but anything on Stop runs after EVERY turn,
  // and a session-end script written for Claude Code that makes a model call
  // becomes one billed call per turn (CROFT-290).
  const foreign = foreignHooks(config.hooks)
  if (foreign.length > 0) {
    log(`  codex: ${foreign.length} hook(s) in ${path} are not Croft's — left untouched:`)
    for (const { event, command } of foreign) {
      log(`         ${event}${event === 'Stop' ? ' (runs every turn)' : ''}: ${command}`)
    }
  }
}

// --- Hermes Agent by Nous Research ------------------------------------------

/**
 * Hermes Agent by Nous Research can return injected context only from
 * pre_llm_call; on_session_start runs once but ignores hook output. The context
 * hook checks extra.is_first_turn, making pre_llm_call a session briefing rather
 * than a cache-breaking query on every turn.
 *
 * Hermes owns atomic config.yaml writes and hook consent. Merge through its CLI
 * and never pre-approve a hook: interactive Hermes asks on first use, while
 * unattended sessions require an explicit operator opt-in.
 */
const installHermes = () => {
  let before
  try {
    const raw = execFileSync('hermes', ['config', 'get', 'hooks', '--json'], { encoding: 'utf8' }).trim()
    before = raw ? JSON.parse(raw) : {}
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return log('  Hermes Agent by Nous Research: not installed — skipped')
    }
    console.error('  Hermes Agent by Nous Research: hooks configuration is unavailable; requires Hermes Agent by Nous Research v0.21.3 or newer with `hermes config get/set` support')
    process.exitCode = 1
    return
  }
  if (!before || Array.isArray(before) || typeof before !== 'object') {
    console.error('  Hermes Agent by Nous Research: hooks configuration is not a mapping; requires Hermes Agent by Nous Research v0.21.3 or newer')
    process.exitCode = 1
    return
  }

  const hookCli = process.env.CROFT_HOOK_CLI?.trim() || 'croft'
  if (!isSafeHookCli(hookCli)) {
    console.error('  Hermes Agent by Nous Research: CROFT_HOOK_CLI must be one safe executable path; refusing to write a hook that would not run')
    process.exitCode = 1
    return
  }

  const hooks = JSON.parse(JSON.stringify(before))
  const command = `env CROFT_AGENT=hermes CROFT_PLATFORM=hermes CROFT_CLI=${hookCli} node ${CONTEXT}`
  const current = Array.isArray(hooks.pre_llm_call) ? hooks.pre_llm_call : []
  const cairn = cairnBriefing(current)
  const carried = cairn === 'carries'
  if (cairn === 'predates') log(`  Hermes Agent by Nous Research: ${PREDATES}`)
  const others = current.filter((entry) => !isMine(entry))
  if (carried) {
    if (others.length) hooks.pre_llm_call = others
    else delete hooks.pre_llm_call
  } else {
    hooks.pre_llm_call = [...others, { command, timeout: 10 }]
  }
  if (carried) log(`  Hermes Agent by Nous Research: ${CARRIED}`)

  if (canonicalHermesHooks(before) === canonicalHermesHooks(hooks)) {
    return carried ? undefined : log('  Hermes Agent by Nous Research: pre_llm_call — unchanged')
  }
  if (DRY) return log('  Hermes Agent by Nous Research: would configure pre_llm_call')

  try {
    execFileSync('hermes', ['config', 'set', '--force', 'hooks', JSON.stringify(hooks)], { stdio: 'inherit' })
  } catch {
    console.error('  Hermes Agent by Nous Research: could not update hooks configuration; requires Hermes Agent by Nous Research v0.21.3 or newer with `hermes config get/set` support')
    process.exitCode = 1
    return
  }

  // A zero exit from `config set` is a claim, not a result. No Hermes runs on
  // any machine here, so every promise this installer makes about it rests on
  // reading back what it wrote rather than trusting the status it was handed.
  if (carried) return log('  Hermes Agent by Nous Research: removed Croft\'s pre_llm_call entry')
  if (!hermesHookInstalled()) {
    console.error('  Hermes Agent by Nous Research: `hermes config set` reported success but the hook is not in the config it reads back — nothing was installed')
    process.exitCode = 1
    return
  }

  log('  Hermes Agent by Nous Research: pre_llm_call (briefing on first turn)')
  log('  Hermes Agent by Nous Research: approve the hook on first use; the installer never auto-accepts it')
}

/** Re-read the hooks config and confirm our pre_llm_call entry survived the write. */
const hermesHookInstalled = () => {
  try {
    const raw = execFileSync('hermes', ['config', 'get', 'hooks', '--json'], { encoding: 'utf8' }).trim()
    const after = raw ? JSON.parse(raw) : {}
    return Array.isArray(after.pre_llm_call) && after.pre_llm_call.some(isMine)
  } catch {
    return false
  }
}

// --- OpenClaw ---------------------------------------------------------------

/**
 * OpenClaw has no session-start event that returns text; what it has is
 * `agent:bootstrap`, with a mutable bootstrapFiles list. hooks/openclaw/
 * croft-briefing is a hook for exactly that, shipped here so every OpenClaw
 * install gets the same one.
 *
 * Where it lives decides whether it runs, and the obvious places are wrong.
 * OpenClaw discovers directory hooks only in `<workspace>/hooks`, the managed
 * `~/.openclaw/hooks`, `hooks.internal.load.extraDirs`, plugins and its own
 * bundle. A hook kept in some other tree is enabled in config and never loaded
 * — silently: one found this way had reached 0 of 406 sessions after the
 * workspace moved, and `hooks.path`, which looks like the setting, is the
 * webhook URL path. So the copy goes to a stable path under ~/.croft (where
 * sync-agent-files keeps it current, like the other two hooks), and OpenClaw
 * is told about it with its own documented command, `hooks install --link`,
 * which adds that one directory to extraDirs and enables the hook.
 *
 * Not linked where Cairn's cairn-briefing hook is: Cairn's briefing carries
 * Croft's block there.
 */
const OPENCLAW_HOOK = join(HOME, '.croft', 'hooks', 'openclaw', 'croft-briefing')
const OPENCLAW_HOOK_FILES = ['HOOK.md', 'handler.ts']
const OPENCLAW_HOOK_NAME = 'croft-briefing'
const openclawArgs = (force = true) => ['hooks', 'install', '--link', OPENCLAW_HOOK, ...(force ? ['--force'] : [])]
const openclawCommand = `openclaw ${openclawArgs().join(' ')}`
/** `CROFT_OPENCLAW_BIN` for an OpenClaw that is not on PATH as `openclaw`. */
const OPENCLAW_BIN = process.env.CROFT_OPENCLAW_BIN?.trim() || 'openclaw'

const onPath = (bin) =>
  bin.includes('/')
    ? existsSync(bin)
    : (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, bin)))

/**
 * Whether OpenClaw's config already links and enables this hook, so a re-run
 * does not rewrite it and ask for a gateway restart that changes nothing. Any
 * doubt — no file, JSON5 it cannot parse — answers no, and the install runs,
 * which is itself idempotent.
 */
const openclawConfig = () =>
  process.env.OPENCLAW_CONFIG_PATH?.trim() || join(HOME, '.openclaw', 'openclaw.json')

/**
 * Whether this account runs a gateway, judged from its config. A file alone is
 * not enough: an account can hold a client config — only `gateway.auth`, so its
 * CLI can reach another account's gateway — and a sync job may keep that file
 * immutable. A gateway's own config says where it listens or what it runs.
 * A file that exists but will not parse (JSON5) gets the benefit of the doubt.
 */
const openclawRunsGateway = () => {
  const path = openclawConfig()
  if (!existsSync(path)) return false
  let config
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return true
  }
  const gateway = config?.gateway ?? {}
  return Boolean(gateway.mode || gateway.port || config?.agents || config?.channels)
}

/** Cairn's own briefing hook, enabled in this gateway's config. */
const cairnBriefingLinked = () => {
  const internal = readJson(openclawConfig())?.hooks?.internal
  return internal?.enabled !== false && internal?.entries?.['cairn-briefing']?.enabled === true
}

const openclawLinked = () => {
  const internal = readJson(openclawConfig())?.hooks?.internal
  return (
    internal?.enabled !== false &&
    (internal?.load?.extraDirs ?? []).includes(OPENCLAW_HOOK) &&
    internal?.entries?.[OPENCLAW_HOOK_NAME]?.enabled === true
  )
}

/** Copy the hook to its stable path; true when any file changed. */
const copyOpenclawHook = () => {
  mkdirSync(OPENCLAW_HOOK, { recursive: true })
  let changed = false
  for (const file of OPENCLAW_HOOK_FILES) {
    const source = readFileSync(join(REPO, 'hooks', 'openclaw', 'croft-briefing', file))
    const target = join(OPENCLAW_HOOK, file)
    if (existsSync(target) && readFileSync(target).equals(source)) continue
    writeFileSync(target, source)
    changed = true
  }
  return changed
}

const openclawTail = () => {
  log('  openclaw: set CROFT_AGENT=openclaw where the gateway starts; see docs/openclaw.md')
}

/**
 * `--force` is how current OpenClaw re-links over an existing install record.
 * An older one rejects the flag outright, and for a link it was never needed:
 * the directory is merged into extraDirs as a set. So an "unknown option"
 * refusal is retried without it, and anything else is a real failure.
 */
const runOpenclawInstall = () => {
  try {
    execFileSync(OPENCLAW_BIN, openclawArgs(), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (!/unknown option/i.test(`${error.stderr ?? ''}${error.stdout ?? ''}`)) throw error
    execFileSync(OPENCLAW_BIN, openclawArgs(false), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
}

const installOpenclaw = () => {
  if (!onPath(OPENCLAW_BIN)) {
    log('  openclaw: not on PATH — skipped. Where it runs, as the gateway user:')
    log(`            croft setup   (or: node scripts/install-hooks.mjs, or ${openclawCommand})`)
    return
  }
  // `openclaw` on PATH says it is installed, not that this user runs a gateway:
  // a global npm install puts it on every account's PATH. Linking from an
  // account that runs none would write a config no gateway reads (or fail on a
  // locked client config) and leave the real gateway unbriefed (CROFT-296).
  if (!FORCE_OPENCLAW && !openclawRunsGateway()) {
    const why = existsSync(openclawConfig())
      ? `${openclawConfig()} is a client config (no gateway in it)`
      : `no config at ${openclawConfig()}`
    log(`  openclaw: ${why} — this account runs no gateway; skipped.`)
    log('            Run the installer as the gateway\'s user, or pass --openclaw to link here anyway.')
    return
  }
  if (cairnBriefingLinked()) {
    log(`  openclaw: ${CARRIED}`)
    if (openclawLinked()) {
      log(`  openclaw: ${OPENCLAW_HOOK_NAME} is enabled too — set hooks.internal.entries.${OPENCLAW_HOOK_NAME}.enabled to false in ${openclawConfig()}`)
    }
    return
  }
  if (DRY) {
    log(`  openclaw: would copy the croft-briefing hook to ${OPENCLAW_HOOK}`)
    log(`  openclaw: would run: ${openclawCommand}`)
    log('  openclaw: then the gateway needs a restart to load it')
    return openclawTail()
  }

  const changed = copyOpenclawHook()
  if (openclawLinked()) {
    log(`  openclaw: croft-briefing already linked from ${OPENCLAW_HOOK}${changed ? ' — handler updated' : ' — unchanged'}`)
    if (changed) log('  openclaw: restart the gateway to load the new handler')
    return openclawTail()
  }

  try {
    runOpenclawInstall()
  } catch (error) {
    console.error(`  openclaw: \`${openclawCommand}\` failed (exit ${error.status ?? error.code ?? '?'})`)
    const said = String(error.stderr ?? '').trim()
    if (said) console.error(`            ${said.split('\n').join('\n            ')}`)
    console.error(`            the hook is copied to ${OPENCLAW_HOOK}; run the command above by hand`)
    process.exitCode = 1
    return
  }
  log(`  openclaw: agent:bootstrap -> croft-briefing, linked from ${OPENCLAW_HOOK}`)
  log('  openclaw: restart the gateway to load it (OpenClaw loads hooks only at start)')
  openclawTail()
}

const version = () => {
  const cli = process.env.CROFT_HOOK_CLI?.trim() || 'croft'
  if (!isSafeHookCli(cli)) return 'CROFT_HOOK_CLI must be one safe executable path'
  try {
    return execFileSync(cli, ['--help'], { encoding: 'utf8' }).split('\n')[0]
  } catch {
    return `${cli} CLI not on PATH — install it first`
  }
}

log(`Installing Croft hooks${DRY ? ' (dry run)' : ''}`)
log(`  ${version()}`)
installScripts()
installClaude()
installCodex()
installHermes()
installOpenclaw()

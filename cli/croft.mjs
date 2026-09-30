#!/usr/bin/env node
/**
 * croft — the single implementation every agent calls.
 *
 * Deliberately dependency-free: Node 22's built-in fetch is enough, so the CLI
 * can be dropped onto a box and run without an install step. Claude Code,
 * Codex and OpenClaw all reach it the same way, through a shell.
 *
 * Output discipline is the point, not a detail. Lists are TSV with the keys
 * emitted once as a header, nulls omitted, a count-first line so the caller
 * can paginate before parsing, and — on search — an estimated token cost per
 * row so the model can decline to open something.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { homedir, hostname } from 'node:os'

const CROFT_DIR = join(homedir(), '.croft')

/**
 * Credentials come from the environment, falling back to ~/.croft/env — so an
 * agent skill works without the user having to edit a shell profile first.
 * Format is plain KEY=value lines.
 */
const fileEnv = (path) => {
  try {
    if (!path || !existsSync(path)) return {}
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const i = line.indexOf('=')
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
        }),
    )
  } catch {
    return {}
  }
}

/**
 * Kept in step with package.json by a test, because this file is copied to
 * machines rather than installed from a registry: it is the copy on the box
 * that matters, and nothing else would notice it going stale. A CLI three days
 * old was found writing under the wrong identity exactly once, which was
 * enough.
 */
const VERSION = '0.3.1'

/**
 * Which Croft this command talks to, on a machine that uses more than one.
 *
 * One machine can hold a personal and a professional instance, and nothing in
 * a task ref, a project key or a directory name says which a command is for.
 * Guessing is how a client's notes end up on the personal server, so the
 * choice is explicit or it is not made: `--instance`, CROFT_INSTANCE, or the
 * default ~/.croft/instances.json names. With none of them, and the file set to
 * ask, the command stops before any request with exit 10, which tells an agent
 * to ask the user rather than try again.
 *
 * Every instance keeps its own state in ~/.croft/instances/<name>/ — env,
 * outbox, ownership, projects.json — because a ref or a directory mapped on
 * one means nothing on the other. No instances.json is the single-instance
 * machine this CLI has always served, and nothing about it changes.
 */
const INSTANCES_PATH = join(CROFT_DIR, 'instances.json')
const INSTANCE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const UNDECIDED_EXIT = 10
const EXIT_CODES = { already_claimed: 9, session_closed: 11 }

const readInstances = () => {
  if (!existsSync(INSTANCES_PATH)) return null
  let config
  try {
    config = JSON.parse(readFileSync(INSTANCES_PATH, 'utf8'))
  } catch (error) {
    return { error: `~/.croft/instances.json is not valid JSON (${error.message})` }
  }
  if (config?.version !== 1) return { error: '~/.croft/instances.json: "version" must be 1' }
  const instances = config.instances
  if (!instances || typeof instances !== 'object' || Array.isArray(instances) || !Object.keys(instances).length) {
    return { error: '~/.croft/instances.json: "instances" must name at least one instance' }
  }
  for (const [name, instance] of Object.entries(instances)) {
    if (!INSTANCE_NAME.test(name)) {
      return { error: `~/.croft/instances.json: "${name}" is not an instance name (lowercase letters, digits and dashes)` }
    }
    let url
    try { url = new URL(instance?.url) } catch { /* reported below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      return { error: `~/.croft/instances.json: instance "${name}" needs an http(s) "url"` }
    }
  }
  const unclassified = config.unclassified ?? { mode: 'ask' }
  if (unclassified.mode === 'default' ? !instances[unclassified.instance] : unclassified.mode !== 'ask') {
    return {
      error: '~/.croft/instances.json: "unclassified" must be {"mode": "ask"} or ' +
        '{"mode": "default", "instance": <one of the instances>}',
    }
  }
  if (config.routes !== undefined && !Array.isArray(config.routes)) {
    return { error: '~/.croft/instances.json: "routes" must be a list' }
  }
  // Compared canonically, so a hand-written /tmp/x matches the /private/tmp/x
  // a directory resolves to on macOS.
  const routes = (config.routes ?? []).map((r) => (typeof r?.path === 'string' && isAbsolute(r.path) ? { ...r, path: realDir(r.path) } : r))
  for (const route of routes) {
    const problem = routeProblem(route, instances, routes)
    if (problem) return { error: `~/.croft/instances.json: ${problem}` }
  }
  return { instances, unclassified, routes, raw: config }
}

/**
 * A flag's value, read before the parser runs because the credentials below
 * depend on it, and read the way the parser reads it: the last one wins, and
 * a bare flag is '' rather than "not given".
 */
const earlyFlag = (name) => {
  const argv = process.argv.slice(2)
  let found
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith(`--${name}=`)) found = argv[i].slice(name.length + 3)
    else if (argv[i] === `--${name}`) found = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : ''
  }
  return found
}

/**
 * The words that are not flags or flag values, split the way the parser below
 * splits them. Routing has to know which word is the command and which is its
 * ref: `block --reason DONE-1 CAI-42` is about CAI-42, and the reason's text
 * must not decide where it goes.
 */
const earlyPositional = (() => {
  const argv = process.argv.slice(2)
  const words = []
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) words.push(argv[i])
    else if (!argv[i].includes('=') && argv[i + 1] && !argv[i + 1].startsWith('--')) i += 1
  }
  return words
})()

/**
 * A bare `--instance` is an error rather than "none given": on a machine with
 * a default, the second reading would send a mistyped command to the default.
 */
const requestedInstance = () => {
  const flag = earlyFlag('instance')
  if (flag !== undefined) return flag ? { name: flag } : { error: '--instance needs the name of an instance' }
  const fromEnv = process.env.CROFT_INSTANCE?.trim()
  return fromEnv ? { name: fromEnv } : {}
}

// ---------------------------------------------------------------------------
// routes: which instance a directory, a ref or a session belongs to
// ---------------------------------------------------------------------------
const HOME = homedir()
const SESSION_ROUTES_DIR = join(CROFT_DIR, 'session-routes')
const SESSION_ID = /^[A-Za-z0-9._:-]{1,100}$/
// One letter is a key too: todos live in project T (T-41). S-n is a subject,
// which belongs to no project and never routes by key.
const REF_ARG = /^([A-Z][A-Z0-9]{0,9})-\d+$/
const TODO_KEY = 'T'

/** For messages: a path under the home directory, without the username in it. */
const tilde = (path) => (path === HOME ? '~' : path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path)

const realDir = (dir) => {
  try { return realpathSync(dir) } catch { return dir }
}

/**
 * What a directory is routed by: the main checkout of the repository it is in,
 * or the directory itself outside one.
 *
 * The main checkout rather than the worktree, because a worktree is the same
 * work in another folder and classifying every one of them by hand is how the
 * question gets asked forty times. GIT_DIR and friends are dropped: an
 * environment variable must not be able to say which repository this is.
 */
const routeKeys = new Map()
const routeKey = (dir) => {
  if (!routeKeys.has(dir)) routeKeys.set(dir, computeRouteKey(dir))
  return routeKeys.get(dir)
}
const computeRouteKey = (dir) => {
  const real = realDir(dir)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE)$/.test(k)))
  try {
    const [top, common] = execFileSync(
      'git',
      ['-C', real, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000, env },
    ).trim().split('\n')
    return { key: realDir(basename(common) === '.git' ? dirname(common) : top), repo: true }
  } catch {
    return { key: real, repo: false }
  }
}

/**
 * An exact route names one repository or directory; a folder route covers
 * everything under it. Exact beats folder, and folders never nest, so there is
 * never a question of which of two rules won.
 */
const routeFor = (key, routes) =>
  routes.find((r) => r.match === 'exact' && r.path === key) ??
  routes.find((r) => r.match === 'folder' && (key === r.path || key.startsWith(`${r.path}/`))) ??
  null

/**
 * Why a route cannot be saved, or null. A folder route on the home directory
 * or the root would classify everything at once, which is the mistake this
 * whole mechanism exists to prevent; the default instance is the catch-all.
 */
const routeProblem = (route, instances, routes) => {
  if (!route || typeof route.path !== 'string' || !isAbsolute(route.path)) return 'a route needs an absolute "path"'
  if (!['exact', 'folder'].includes(route.match)) return `route ${tilde(route.path)}: "match" must be "exact" or "folder"`
  if (!instances[route.instance]) return `route ${tilde(route.path)}: no instance named "${route.instance}"`
  if (route.match === 'folder') {
    if (route.path === '/' || route.path === HOME) {
      return `a folder route on ${tilde(route.path)} would classify everything under it; use the default instance instead`
    }
    const clash = routes.find((r) => r !== route && r.match === 'folder' &&
      (r.path === route.path || r.path.startsWith(`${route.path}/`) || route.path.startsWith(`${r.path}/`)))
    if (clash) return `folder routes ${tilde(clash.path)} and ${tilde(route.path)} overlap; keep one`
  }
  if (route.match === 'exact' && routes.some((r) => r !== route && r.match === 'exact' && r.path === route.path)) {
    return `${tilde(route.path)} is routed twice`
  }
  return null
}

const instanceDir = (name) => join(CROFT_DIR, 'instances', name)

/**
 * The project keys each instance was last seen to have, refreshed by that
 * instance's own requests. Read only here, so a ref names its instance without
 * a question and without asking a server that may not be the one it is for.
 */
const PROJECT_KEYS_FILE = 'project-keys.json'
const PROJECT_KEYS_TTL_MS = 6 * 60 * 60 * 1000
const instancesWithKey = (key, instances) =>
  Object.keys(instances).filter((name) => {
    try {
      return JSON.parse(readFileSync(join(instanceDir(name), PROJECT_KEYS_FILE), 'utf8')).keys?.includes(key)
    } catch {
      return false
    }
  })

/**
 * Whether ONE instance's own project-key cache is too old, missing or
 * unreadable to answer for it — never a statement about any other instance.
 * Missing or unreadable is treated as stale rather than "no projects": an
 * instance that has never been reached, or answered with something this
 * could not parse, has told us nothing about what it owns.
 */
const isStaleInstance = (name) => {
  const path = join(instanceDir(name), PROJECT_KEYS_FILE)
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(cached.keys)) return true
    const at = Date.parse(cached.at ?? '')
    const age = Number.isFinite(at) ? Date.now() - at : Date.now() - statSync(path).mtimeMs
    return age >= PROJECT_KEYS_TTL_MS
  } catch {
    return true
  }
}

/**
 * Stricter than `isStaleInstance`: true only when an instance has NEVER
 * produced a readable project-key cache, as opposed to one that did and has
 * simply gone stale with age (the normal state of any secondary instance
 * nobody has used in six hours). Staleness-by-age is a risk this file already
 * accepts elsewhere — a brand-new project on a reachable instance, before its
 * first key request, is invisible the same way. An instance that has never
 * been reached at all is a sharper problem: EVERY project it owns is
 * invisible, permanently, not just the ones created since its last refresh —
 * so it gets its own check before this file lets an unclassified ref default
 * to somewhere else.
 */
const neverReachedInstance = (name) => {
  try {
    const cached = JSON.parse(readFileSync(join(instanceDir(name), PROJECT_KEYS_FILE), 'utf8'))
    return !Array.isArray(cached.keys)
  } catch {
    return true
  }
}

/**
 * A fixed, short budget for finding out whether a stale cache is merely old
 * or genuinely unreachable, tried only for instances resolveRoute already
 * knows are stale. Not CROFT_DEADLINE_MS: that constant is not defined yet
 * when this file's top-level routing runs (it is read from the environment
 * further down, after the instance is already chosen), and this must not
 * inherit a caller's much longer budget anyway — routing is a hint, and a
 * hint that can take 15 seconds to fail defeats the point of being one.
 */
const ROUTE_REFRESH_TIMEOUT_MS = 1500

/**
 * Ask ONE instance — by its own URL and its own key, never this process's —
 * what it currently owns, and update its cache if it answers. This is the
 * same request `refreshProjectKeys` makes for the instance this process is
 * running as, made usable for any instance named in instances.json, because a
 * routing decision needs to know whether a stale neighbour is merely quiet or
 * actually unreachable, and it needs to know that about instances this
 * process never selected and has no session with.
 *
 * A missing env file, an instance with no key on it, a timeout, a network
 * error, or a non-success payload all resolve to `false` — every one of them
 * is "could not confirm", and the caller falls back to treating the cache as
 * still stale.
 */
const refreshInstanceKeysFor = async (name, instances) => {
  // Not `trimUrl`: that helper is declared later in this file, after the
  // top-level routing decision that can already need this function has run.
  const url = (instances[name]?.url ?? '').replace(/\/+$/, '')
  if (!url) return false
  const env = fileEnv(join(instanceDir(name), 'env'))
  const key = env.CROFT_API_KEY || Object.entries(env).find(([k]) => k.startsWith('CROFT_API_KEY_'))?.[1]
  if (!key) return false
  try {
    const res = await fetch(`${url}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(ROUTE_REFRESH_TIMEOUT_MS),
    })
    if (!res.ok) return false
    const payload = await res.json()
    if (!payload?.success || !Array.isArray(payload.data)) return false
    // Active projects only, same as refreshProjectKeys: an archived project's
    // copy must not keep claiming a ref that has moved on.
    const keys = [...new Set(payload.data.flatMap((p) => [p.key, ...(p.former_keys ?? []).map((f) => f.key)]).filter(Boolean))]
    const dir = instanceDir(name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, PROJECT_KEYS_FILE)
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ at: new Date().toISOString(), keys })}\n`, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    return true
  } catch {
    return false
  }
}

const routeSession = () => {
  const id = (process.env.CROFT_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID || '').trim()
  return SESSION_ID.test(id) ? id : null
}

const sessionRoute = (session, instances) => {
  if (!session) return null
  try {
    const { instance } = JSON.parse(readFileSync(join(SESSION_ROUTES_DIR, `${session}.json`), 'utf8'))
    return instances[instance] ? instance : null
  } catch {
    return null
  }
}

/**
 * Where a directory's commands go, and why — or why nothing can be said.
 *
 * A saved route comes before a ref: it is an answer somebody gave on purpose,
 * and the ref's side is a cache of project keys that can be hours old. When
 * the two disagree the route still wins, and the caller is told how to send
 * the one command elsewhere rather than having it done for them.
 *
 * Async because a ref-shaped command with a stale instance in play first
 * tries to make that instance's cache current (`refreshInstanceKeysFor`)
 * before deciding anything — see the block below the saved-route check. Every
 * other path returns without awaiting anything, so a command with no stale
 * instance to worry about pays nothing for this being async.
 */
const resolveRoute = async ({ config, dir, session, ref }) => {
  const { instances, unclassified, routes } = config
  const { key, repo } = routeKey(dir)
  const route = routeFor(key, routes)
  if (route) {
    const owners = ref ? instancesWithKey(ref, instances) : []
    const elsewhere = owners.length === 1 && owners[0] !== route.instance
    return {
      name: route.instance,
      why: `${route.match === 'folder' ? 'folder ' : ''}route ${tilde(route.path)}`,
      ...(elsewhere ? { hint: `croft: ${ref} is a project on ${owners[0]}, and this directory is routed to ${route.instance}; add --instance ${owners[0]} if it is meant for ${owners[0]}` } : {}),
    }
  }
  const bySession = sessionRoute(session, instances)
  if (!ref) {
    if (bySession) return { name: bySession, why: 'chosen for this session' }
    if (unclassified.mode === 'default') return { name: unclassified.instance, why: 'default instance' }
    return { name: null, key, repo }
  }

  // A ref-shaped command must not fall through to a session/default when the
  // ownership cache may have changed. An explicit --instance or saved route
  // remains available, and the next request to that instance refreshes keys.
  //
  // CROFT-305 refined this, and CROFT-316 is why it had to: keys are
  // PER-INSTANCE, so `owners` below looks at every instance's last-known
  // cache, stale or fresh, and only an instance whose cache actually LISTS
  // this ref's key is in it. Blocking every ref-shaped command whenever ANY
  // instance was stale — the original rule — refused personal work on every
  // project a healthy instance plainly owns, for as long as one unrelated
  // instance was unreachable (an office WAF returning 403 on every request
  // was enough). What actually has to be refused is narrower: a ref whose
  // only evidence of ownership is stale, or whose ownership is disputed.
  //
  // But "stale" is the ordinary state of any secondary instance nobody has
  // used in six hours, not a sign of trouble — most of the time, asking it is
  // cheap and just works. So before any of that: every instance this file
  // currently believes is stale gets one short, parallel, best-effort chance
  // (refreshInstanceKeysFor, ROUTE_REFRESH_TIMEOUT_MS each) to say what it
  // owns right now, with its own key against its own URL. `owners` and
  // `isStaleInstance` below are read AFTER this, so a neighbour that answers
  // is treated exactly like one that was fresh all along — no separate "just
  // refreshed" rule to keep in step with the normal one. A neighbour that
  // does not answer (still down, still never reached) leaves the cache
  // exactly as it was, and every rule below applies to it unchanged.
  //
  // This is also the fix for a NEVER-reached instance (no project-keys.json
  // at all, not just an old one): without a chance to answer for itself first,
  // such an instance can never appear in `owners` — every project it owns is
  // permanently invisible, not just the ones created since some last refresh.
  // A merely-aged cache that plainly does not list this key is a smaller,
  // already-accepted risk (a brand-new project on a reachable instance,
  // before its first key request, is invisible the same way) — this file
  // does not chase that one further; the server's own 409 on an archived
  // project is the backstop for the closely related case of a project that
  // just moved: the instance it moved to may still show up here as the sole
  // fresh owner while its own cache has not yet caught up, exactly as before.
  const staleNow = Object.keys(instances).filter((name) => isStaleInstance(name))
  if (staleNow.length > 0) {
    await Promise.all(staleNow.map((name) => refreshInstanceKeysFor(name, instances)))
  }

  const owners = instancesWithKey(ref, instances)
  const staleOwners = owners.filter((name) => isStaleInstance(name))
  if (staleOwners.length > 0) {
    return {
      name: null,
      error: `croft: ${staleOwners.join(', ')} last claimed ${ref} but could not be reached just now to confirm it still does; ` +
        `retry with an explicit --instance once it answers`,
    }
  }
  if (owners.length > 1) {
    return { name: null, error: `croft: ${ref} is claimed by multiple Croft instances (${owners.join(', ')}); use --instance <name>` }
  }
  if (owners.length === 1) {
    // Every remaining owner is fresh (staleOwners was empty above); an
    // unrelated instance that still could not be checked, even after the
    // refresh attempt above, did not claim this key, so it is worth a note,
    // never a refusal.
    const uncheckable = Object.keys(instances).filter((name) => name !== owners[0] && isStaleInstance(name))
    return {
      name: owners[0],
      why: `${ref} is a project there`,
      ...(uncheckable.length
        ? { hint: `croft: ${uncheckable.join(', ')} could not be checked (stale project cache); routing ${ref} to ${owners[0]} on its own record` }
        : {}),
    }
  }
  if (bySession) return { name: bySession, why: 'chosen for this session' }
  if (unclassified.mode === 'default') {
    // Nothing claims this ref — the ordinary shape of a brand-new project.
    // But a default only silently proceeds if no instance's silence about
    // owning it is itself untrustworthy: an instance that has NEVER been
    // reached (still true after the refresh attempt above) has told this
    // file nothing at all, ever, and defaulting past it is exactly the "every
    // project on that instance is invisible" bug this file must not repeat.
    const unseen = Object.keys(instances).filter((name) => name !== unclassified.instance && neverReachedInstance(name))
    if (unseen.length > 0) {
      return {
        name: null,
        error: `croft: ${unseen.join(', ')} has never been reached, so it is not known whether ${ref} belongs to it ` +
          `rather than to the default (${unclassified.instance}); retry with an explicit --instance once it answers, ` +
          `e.g. --instance ${unseen[0]}`,
      }
    }
    return { name: unclassified.instance, why: 'default instance' }
  }
  return { name: null, key, repo }
}

const undecidedMessage = ({ key, repo }, instances, session) => {
  const here = repo ? 'this repository' : 'this directory'
  return [
    `croft: this machine uses several Croft instances (${Object.keys(instances).join(', ')}) and nothing says ` +
      `which one ${tilde(key)} is for. Ask the user which one, save the answer, then re-run the command:`,
    `  croft route add <instance>             ${here}`,
    ...(key !== HOME && key !== '/' ? [`  croft route add <instance> --folder    ${tilde(key)} and everything under it`] : []),
    ...(session ? ['  croft route add <instance> --session   this session only'] : []),
    '  (--instance <name> on a command uses that instance for it alone)',
  ].join('\n')
}

const writeInstancesConfig = (config) => {
  wroteLocally = true
  mkdirSync(CROFT_DIR, { recursive: true })
  const temp = `${INSTANCES_PATH}.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, INSTANCES_PATH)
}

/**
 * Save an answer. Returns the problem as a string instead of dying, because
 * the terminal prompt below has to be able to say it and ask again.
 */
const saveRoute = (config, { instance, key, folder, session, force }) => {
  if (!config.instances[instance]) return `no instance named "${instance}" (it has: ${Object.keys(config.instances).join(', ')})`
  if (session) {
    mkdirSync(SESSION_ROUTES_DIR, { recursive: true, mode: 0o700 })
    // A week is longer than any session; the files are one line each.
    for (const f of readdirSync(SESSION_ROUTES_DIR)) {
      try { if (Date.now() - statSync(join(SESSION_ROUTES_DIR, f)).mtimeMs > 7 * 86_400_000) unlinkSync(join(SESSION_ROUTES_DIR, f)) } catch { /* raced */ }
    }
    writeFileSync(join(SESSION_ROUTES_DIR, `${session}.json`), `${JSON.stringify({ instance, t: new Date().toISOString() })}\n`, { mode: 0o600 })
    return null
  }
  const match = folder ? 'folder' : 'exact'
  const existing = config.routes.find((r) => r.match === match && r.path === key)
  if (existing && existing.instance !== instance && !force) {
    return `${tilde(key)} is already routed to ${existing.instance}; re-run with --force to change it on purpose`
  }
  const route = { path: key, match, instance }
  const routes = [...config.routes.filter((r) => r !== existing), route]
  const problem = routeProblem(route, config.instances, routes)
  if (problem) return problem
  // Written from the file as it was, with only the routes changed.
  writeInstancesConfig({ ...(config.raw ?? { instances: config.instances }), version: 1, routes })
  return null
}

/**
 * A local write happened, for the ignored-flag report at the bottom: it must
 * warn rather than exit 2 once something is already on disk. `mutated` is
 * declared too late in the file to be touched from here.
 */
let wroteLocally = false

/**
 * One numbered choice. null on Ctrl-D: readline's question() never settles
 * when its input ends, and Node would then exit 0 with the command half done.
 * A number out of range is asked again rather than read as some default.
 */
const choose = async (rl, prompt, count, fallback) => {
  const closed = new Promise((resolve) => rl.once('close', () => resolve(null)))
  for (;;) {
    const answer = await Promise.race([rl.question(prompt), closed])
    if (answer === null) return null
    const n = answer.trim() === '' && fallback ? fallback : Number(answer.trim())
    if (Number.isInteger(n) && n >= 1 && n <= count) return n
    process.stderr.write(`  a number from 1 to ${count}, please\n`)
  }
}

/** Setup's question: a default instance for unclassified directories, or ask every time. */
const askPolicy = async (instances) => {
  const names = Object.keys(instances)
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    process.stderr.write('croft: when a directory has no route, which instance should commands use?\n')
    names.forEach((n, i) => process.stderr.write(`  ${i + 1}. always ${n}\n`))
    process.stderr.write(`  ${names.length + 1}. none — ask me whenever it is unclear\n`)
    const n = await choose(rl, `choice [${names.length + 1}]: `, names.length + 1, names.length + 1)
    // Unanswered stays unanswered: nothing is written, and the next add asks again.
    if (n === null) return undefined
    return n <= names.length ? { mode: 'default', instance: names[n - 1] } : { mode: 'ask' }
  } finally {
    rl.close()
  }
}

/** Ask a person at a terminal, once, instead of printing instructions meant for an agent. */
const askInTerminal = async (config, undecided, session) => {
  const names = Object.keys(config.instances)
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    process.stderr.write(`croft: which Croft instance is ${tilde(undecided.key)} for?\n`)
    names.forEach((n, i) => process.stderr.write(`  ${i + 1}. ${n}  ${config.instances[n].url}\n`))
    const n = await choose(rl, 'instance number: ', names.length)
    if (n === null) return null
    const picked = names[n - 1]
    const scopes = [
      ['this one command', null],
      [undecided.repo ? 'this repository' : 'this directory', { key: undecided.key }],
      ...(undecided.key !== HOME && undecided.key !== '/' ? [[`${tilde(undecided.key)} and everything under it`, { key: undecided.key, folder: true }]] : []),
      ...(session ? [['this session only', { session }]] : []),
    ]
    scopes.forEach(([label], i) => process.stderr.write(`  ${i + 1}. ${label}\n`))
    const pickedScope = await choose(rl, 'remember it for [2]: ', scopes.length, 2)
    if (pickedScope === null) return null
    const scope = scopes[pickedScope - 1]
    if (scope[1]) {
      const problem = saveRoute(config, { instance: picked, ...scope[1] })
      if (problem) {
        process.stderr.write(`croft: ${problem}\n`)
        return null
      }
    }
    return picked
  } finally {
    rl.close()
  }
}

const INSTANCES = readInstances()
/**
 * The directory a command is about: `--cwd` when a hook speaks for a session
 * that ran somewhere else, this process's own directory otherwise.
 */
const ROUTE_DIR = earlyFlag('cwd') || process.cwd()
const ROUTE_SESSION = routeSession()
// Commands that only look at local configuration never need an instance, and
// must not stop to ask for one.
const LOCAL_ONLY = new Set(['route', 'instance', 'help', 'setup'])
const EARLY_COMMAND = earlyPositional[0]
const JUST_HELP = (!EARLY_COMMAND && !process.argv.includes('--version')) || EARLY_COMMAND === 'help' || process.argv.includes('--help')
const INTERACTIVE = Boolean(process.stdin.isTTY && process.stderr.isTTY) && !LOCAL_ONLY.has(EARLY_COMMAND) &&
  !process.argv.includes('--all-instances') &&
  !JUST_HELP && !process.argv.includes('--version') && EARLY_COMMAND !== 'version' &&
  !process.argv.includes('--brief')

const selectInstance = async () => {
  const { name: requested, error } = requestedInstance()
  if (error) return { error }
  if (!INSTANCES) {
    return requested
      ? { error: `--instance ${requested}: this machine has no ~/.croft/instances.json, so it has one instance` }
      : { name: null, dir: CROFT_DIR }
  }
  if (INSTANCES.error) return { error: INSTANCES.error }
  const { instances } = INSTANCES
  const at = (name, why) => ({ name, why, dir: instanceDir(name), url: instances[name].url.replace(/\/+$/, '') })
  if (requested) {
    return instances[requested]
      ? at(requested, 'asked for')
      : { error: `no instance named "${requested}" in ~/.croft/instances.json (it has: ${Object.keys(instances).join(', ')})` }
  }
  // Help reads nothing and sends nothing; it should not wait on git to say so.
  if (JUST_HELP) return { undecided: 'croft: no instance chosen' }
  const refWord = EARLY_COMMAND === 'task' && earlyPositional[1] === 'delete'
    ? earlyPositional[2]
    : earlyPositional[1]
  // Every Croft instance has a T project, so T-41 says nothing about which
  // instance it is on; the directory decides, as for a command with no ref.
  const refKey = EARLY_COMMAND === 'subject' ? undefined : REF_ARG.exec(refWord ?? '')?.[1]
  const ref = refKey === TODO_KEY || refKey === 'S' ? undefined : refKey
  const route = await resolveRoute({ config: INSTANCES, dir: ROUTE_DIR, session: ROUTE_SESSION, ref })
  if (route.hint) process.stderr.write(`${route.hint}\n`)
  if (route.error) return { undecided: route.error }
  if (route.name) return at(route.name, route.why)
  if (INTERACTIVE) {
    const picked = await askInTerminal(INSTANCES, route, ROUTE_SESSION)
    if (picked) return at(picked, 'chosen at the terminal')
  }
  return { undecided: undecidedMessage(route, instances, ROUTE_SESSION), route }
}

const INSTANCE = await selectInstance()

/** Where this instance's files live, for messages: never a path with a username in it. */
const STATE_LABEL = INSTANCE.name ? `~/.croft/instances/${INSTANCE.name}` : '~/.croft'
const ENV_LABEL = `${STATE_LABEL}/env`
const STATE_DIR = INSTANCE.dir ?? CROFT_DIR

const FILE_ENV = fileEnv(INSTANCE.dir && join(INSTANCE.dir, 'env'))
/**
 * Which session is running this command.
 *
 * The API key names a runtime and a human -- `claude-code · cal@example.com`
 * -- and every Claude Code session on a machine sends the same one. That is an
 * identity, not a worker, and the difference cost a duplicated implementation
 * the day this was written: two sessions picked up the same task because
 * neither could see who held it.
 *
 * Claude Code puts the session id in the environment of every command it runs,
 * and it is the same id as the transcript's, so this costs nothing to obtain.
 * CROFT_SESSION_ID is the override for a runtime that knows better, and no
 * session at all is a perfectly normal answer -- the server treats an absent
 * session exactly as it behaved before any of this existed.
 */
const SESSION = (() => {
  const raw = (process.env.CROFT_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '').trim()
  return raw && raw.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(raw) ? raw : null
})()

/**
 * Which machine is speaking.
 *
 * A key names a runtime and a human, and the same key names go onto every
 * machine that human uses — so `claude-code · cal@…` on a laptop and on a
 * server are one actor string, and a misattributed note cannot be traced back
 * to the box that wrote it (CROFT-290). The actor string is deliberately left
 * alone: it is the join key for the whole history. The host travels beside it
 * and the server records it where a row already has room for it. An older
 * server ignores the header.
 */
/**
 * CROFT_SHARE_LOCATION=off, in the environment or the instance's env file,
 * keeps this machine's layout on this machine: no working directory, no git
 * remote and no hostname leave it. Paths name clients and projects; on a
 * shared instance every member can read what arrives with them. `context`
 * then resolves the project only from `croft map` or --project, and an
 * explicit CROFT_HOST is still sent, since it is a label someone chose.
 */
const SHARE_LOCATION = !/^(off|0|false|no)$/i.test(
  String(process.env.CROFT_SHARE_LOCATION ?? FILE_ENV.CROFT_SHARE_LOCATION ?? 'on').trim(),
)

const HOST = (() => {
  let raw = process.env.CROFT_HOST
  if (raw === undefined && !SHARE_LOCATION) return null
  if (raw === undefined) {
    try { raw = hostname() } catch { raw = '' }
  }
  raw = String(raw ?? '').trim()
  return raw && raw.length <= 100 && /^[A-Za-z0-9._-]+$/.test(raw) ? raw : null
})()

/** Every request carries it, so no endpoint needs a parameter for it. */
const authHeaders = (extra = {}) => ({
  Authorization: `Bearer ${KEY}`,
  ...(SESSION ? { 'X-Croft-Session': SESSION } : {}),
  ...(HOST ? { 'X-Croft-Host': HOST } : {}),
  ...extra,
})

const trimUrl = (url) => (url ?? '').replace(/\/+$/, '')

const BASE = INSTANCE.url ??
  (INSTANCES ? '' : trimUrl(process.env.CROFT_BASE_URL || FILE_ENV.CROFT_BASE_URL || 'http://localhost:3000'))

/**
 * With several instances, a URL or key from anywhere but the chosen instance
 * is refused rather than preferred. The environment wins on a one-instance
 * machine because it is how a command borrows an identity; here it would be
 * how a command silently writes to the wrong server, and a key in the
 * environment does not say which instance it was issued by.
 */
const INSTANCE_REFUSAL = (() => {
  if (INSTANCE.error) return { message: `croft: ${INSTANCE.error}`, code: 2 }
  if (INSTANCE.undecided) return { message: INSTANCE.undecided, code: UNDECIDED_EXIT }
  if (!INSTANCE.name) return null
  for (const [where, url] of [['CROFT_BASE_URL', process.env.CROFT_BASE_URL], [`CROFT_BASE_URL in ${ENV_LABEL}`, FILE_ENV.CROFT_BASE_URL]]) {
    if (url && trimUrl(url) !== BASE) {
      return {
        message: `croft: ${where} points at a different server than instance "${INSTANCE.name}" ` +
          `(~/.croft/instances.json). Remove it; the instance decides the server.`,
        code: 2,
      }
    }
  }
  if (process.env.CROFT_API_KEY) {
    return {
      message: `croft: CROFT_API_KEY is set in the environment, and on a machine with several instances ` +
        `it cannot say which one issued it. Put the key in ${ENV_LABEL} instead.`,
      code: 2,
    }
  }
  return null
})()

/**
 * Which runtime is speaking.
 *
 * The API key IS the identity -- an actor_id comes from the key, not from
 * anything the caller says -- and one key per machine meant every runtime on
 * a host wrote as whoever owned that file — so on one machine every Codex
 * task, claim and close was filed under OpenClaw's name, and no agent could be
 * held to its own behaviour.
 *
 * Per-user key files cannot fix it either: Codex may run as more than one
 * user on the same box, and share a user with OpenClaw.
 *
 * So the runtime names itself, and the file can carry a key per runtime.
 * `CLAUDECODE` is set by Claude Code itself; the others are set where the
 * runtime is launched, which is the only place that knows.
 */
/**
 * Codex's own markers. CODEX_THREAD_ID is exported into every shell Codex
 * runs; the CODEX_MANAGED_* pair comes from its npm launcher.
 */
const hasCodexMarker = (env) =>
  Boolean(
    env.CODEX_THREAD_ID ||
      env.CODEX_SANDBOX ||
      env.CODEX_MANAGED_BY_NPM ||
      env.CODEX_MANAGED_PACKAGE_ROOT,
  )

/** What a process's command line says it is, from its first two words. */
const runtimeOfCommand = (command) => {
  const words = String(command ?? '').trim().split(/\s+/).slice(0, 2).map((w) => basename(w))
  if (words.some((w) => w === 'codex' || w === 'codex.js')) return 'codex'
  if (words.some((w) => w === 'claude') || /@anthropic-ai\/claude-code\//.test(command)) return 'claude-code'
  return null
}

/**
 * The nearest ancestor that is a runtime, walking up from this process.
 *
 * Environment variables are inherited, so they say every runtime this process
 * is nested inside and not which one is innermost: a Codex started from a
 * Claude Code shell carries CLAUDECODE=1 into every command it runs, and all
 * of its writes were filed as claude-code (CROFT-290). The process tree is
 * the one thing that records nesting. Only consulted when the environment is
 * ambiguous, so the ordinary call pays for no `ps` at all.
 */
const innermostRuntime = () => {
  let pid = process.ppid
  for (let hop = 0; hop < 20 && pid > 1; hop += 1) {
    let line
    try {
      line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim()
    } catch {
      return null
    }
    const match = /^(\d+)\s+(.*)$/.exec(line)
    if (!match) return null
    const found = runtimeOfCommand(match[2])
    if (found) return found
    pid = Number(match[1])
  }
  return null
}

const detectAgent = () => {
  if (process.env.CROFT_AGENT) return process.env.CROFT_AGENT.trim().toLowerCase()
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT) {
    // Both sets of markers: nested one way or the other. Ask the process tree,
    // and keep the old answer when it cannot say.
    if (hasCodexMarker(process.env) && innermostRuntime() === 'codex') return 'codex'
    return 'claude-code'
  }

  // OpenClaw runs Codex underneath, pointed at a CODEX_HOME of its own
  // (an `.openclaw/.../codex-home` of its own). Testing for
  // Codex first would therefore file every one of OpenClaw's writes as Codex
  // -- the same misattribution this exists to fix, pointing the other way.
  const codexHome = process.env.CODEX_HOME ?? ''
  if (/openclaw/i.test(codexHome)) return 'openclaw'

  // Any OPENCLAW_* variable at all, rather than two guessed names.
  //
  // The live gateway sets OPENCLAW_SERVICE_MARKER, OPENCLAW_SYSTEMD_UNIT and
  // eight more, and none of them is OPENCLAW_SESSION or OPENCLAW_HOME — the two
  // that were checked here. The whole of OpenClaw's identity therefore rested
  // on its CODEX_HOME containing the word, and if that ever stopped being true
  // it would now fall through to the Codex markers below, which OpenClaw also
  // sets, and file every one of its writes as Codex.
  if (Object.keys(process.env).some((name) => name.startsWith('OPENCLAW_'))) return 'openclaw'

  // CODEX_MANAGED_* are set by Codex itself, and are the only markers that
  // survive being launched directly.
  //
  // Detection used to rest on CODEX_HOME, which Codex reads but does not
  // export, so /usr/local/bin/codex was installed to set it. A live session was
  // found running as `node /usr/bin/codex --yolo` with no CODEX_HOME at all —
  // the wrapper bypassed — so detection returned nothing and the CLI fell back
  // to the machine's default key, which on that host is OpenClaw's. Every
  // Codex write was filed as OpenClaw, exactly as before the wrapper existed.
  //
  // These are checked after the OpenClaw tests on purpose: OpenClaw runs Codex
  // underneath and therefore sets them too.
  if (codexHome || hasCodexMarker(process.env)) return 'codex'
  return ''
}

const AGENT = detectAgent()

/**
 * An explicit CROFT_API_KEY in the environment always wins -- it is how a
 * one-off command borrows another identity. Otherwise the runtime's own key is
 * preferred, and the plain one is the fallback, so a machine that has not been
 * split yet keeps working exactly as before.
 */
const keyNameFor = (agent) => `CROFT_API_KEY_${agent.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

const OWN_KEY = AGENT ? FILE_ENV[keyNameFor(AGENT)] : undefined

const KEY = process.env.CROFT_API_KEY || OWN_KEY || FILE_ENV.CROFT_API_KEY || ''

/**
 * Borrowing another runtime's identity should be a decision, not an accident.
 *
 * On a machine that has been split into per-agent keys, falling back to the
 * plain one files the work under whichever agent that key belongs to. It did
 * exactly that for weeks: Codex could not be detected, so every write it made
 * was attributed to OpenClaw, and nothing anywhere said so — the statistics
 * looked fine, they were just about the wrong agent.
 *
 * A warning rather than a refusal, because the fallback is legitimate on a
 * machine that has not been split, and refusing would break it.
 */
const SPLIT_KEYS = Object.keys(FILE_ENV).filter((name) => name.startsWith('CROFT_API_KEY_'))
const BORROWING =
  !process.env.CROFT_API_KEY && !OWN_KEY && SPLIT_KEYS.length > 0 && Boolean(FILE_ENV.CROFT_API_KEY)

/**
 * Identities that must never borrow, because nobody reads their warnings.
 *
 * `maintenance` runs from a schedule, with its output in a log file or thrown
 * away. On a machine with no CROFT_API_KEY_MAINTENANCE it fell back to the
 * plain key, which on that machine was Claude Code's, and 27 scheduled repair
 * notes on CROFT-107 were filed as claude-code; the warning went to
 * `stdio: 'ignore'` (CROFT-290). An interactive runtime keeps the warning,
 * because refusing would drop a real session's work; a scheduled job loses
 * nothing by failing loudly and being fixed.
 */
const MUST_NOT_BORROW = new Set(['maintenance'])
const IDENTITY_REFUSAL =
  BORROWING && MUST_NOT_BORROW.has(AGENT)
    ? `croft: CROFT_AGENT=${AGENT} has no ${keyNameFor(AGENT)} in ${ENV_LABEL}, and this identity ` +
      `refuses to fall back to the default key, which belongs to another runtime. ` +
      `Add ${keyNameFor(AGENT)}=<a key named ${AGENT}> to ${ENV_LABEL}, or pair one with ` +
      '`croft setup --maintenance` (an administrator approves it).'
    : null

/** Every path that would send the key goes through this first. */
const requireKey = () => {
  if (INSTANCE_REFUSAL) {
    process.stderr.write(`${INSTANCE_REFUSAL.message}\n`)
    process.exit(INSTANCE_REFUSAL.code)
  }
  if (IDENTITY_REFUSAL) {
    process.stderr.write(`${IDENTITY_REFUSAL}\n`)
    process.exit(3)
  }
  if (!KEY) {
    process.stderr.write(
      `CROFT_API_KEY is not set (${INSTANCE.name ? ENV_LABEL : `env, or ${ENV_LABEL}`}). ` +
        '`croft setup --url <instance>` pairs one for each runtime on this machine.\n',
    )
    process.exit(1)
  }
}

if (BORROWING && !IDENTITY_REFUSAL) {
  process.stderr.write(
    `croft: could not tell which runtime this is${AGENT ? ` (${AGENT} has no ${keyNameFor(AGENT)})` : ''}, ` +
      `so this write will be filed under the default key. ` +
      `Set CROFT_AGENT, or add ${AGENT ? keyNameFor(AGENT) : 'CROFT_API_KEY_<AGENT>'} to ${ENV_LABEL}.\n`,
  )
}

const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const positional = []

/**
 * What the caller typed, and what the command actually looked at.
 *
 * KNOWN_FLAGS below catches a flag NOTHING in this file reads. It cannot catch
 * a flag one verb reads and another does not, because it is one list for every
 * verb — and that is a real failure, not a theoretical one: `croft relearn
 * <slug> --global` parsed, printed the updated entry, exited 0, and left the
 * scope exactly as it was, three lines below the comment explaining why a
 * silently dropped flag is unacceptable (CROFT-262).
 *
 * The obvious fix is a table of which flags each verb takes. This is not that,
 * because the argument against a table is right — it rots the first time a
 * verb grows an option, and a wrong entry makes a legitimate command start
 * exiting 2 on every machine at once, which is a worse failure than the one it
 * prevents.
 *
 * So the reads ARE the registry. `flags` is a proxy that records every key
 * looked at while the command runs; afterwards, anything the caller passed and
 * nobody read is reported. Nothing to enumerate, nothing to keep in step, and
 * it is exact rather than approximate — it reports what this invocation did,
 * not what some static analysis believes the code would do.
 */
const typedFlags = {}
const readFlags = new Set()
const flags = new Proxy(typedFlags, {
  get(target, key) {
    if (typeof key === 'string') readFlags.add(key)
    return target[key]
  },
  has(target, key) {
    if (typeof key === 'string') readFlags.add(key)
    return key in target
  },
})

/**
 * Every flag this CLI reads, anywhere.
 *
 * The parser used to accept whatever it was given, so `croft know --banana
 * split` returned results and exited 0, and `--offset 3` — which nothing
 * implements — returned page one forever with no way to discover it. An agent
 * paginating that way cannot tell success from silence, and this CLI's entire
 * audience is agents.
 *
 * The list is global rather than per-command on purpose: it catches the typo
 * and the flag that does not exist, which is the whole failure here, without
 * needing a table per verb that would rot the first time one grows an option.
 *
 * "A real flag passed to a verb that ignores it still passes here — worth
 * knowing, but a smaller problem than a silent wrong answer" is what this
 * comment used to say next, and it was wrong. `relearn --global` was exactly
 * that case, and it WAS a silent wrong answer: the scope did not change and
 * the command printed the entry and exited 0 (CROFT-262). The per-verb half
 * is handled above, by the proxy on `flags` — not by a table, because the
 * objection to a table still stands.
 *
 * BUILT BY HAND AND GUARDED BY A TEST, because the first version was built by
 * grepping `flags.X` and missed every flag read dynamically — `flags[k]` over
 * ['type','status','priority'], and the [flag, field] pairs in `run` and
 * `session end`. That shipped, and `croft add --priority high` — documented in
 * this file's own help — started failing. A whitelist is only as good as its
 * enumeration, so cli-flags.test.ts now asserts that every `--flag` named in
 * the help text is in this set. Add to both, or the test says so.
 */
const KNOWN_FLAGS = new Set([
  'adopt', 'all', 'all-instances', 'also-project', 'archived', 'assignee', 'body', 'branch', 'brief',
  'conclusion', 'confirm', 'cwd', 'default', 'dir', 'dry-run', 'duplicate-of', 'duration-ms', 'exit-code',
  'file', 'folder', 'force', 'force-empty', 'full', 'help', 'instance', 'json', 'key', 'kind', 'kinds',
  'label', 'limit', 'link', 'maintenance', 'member', 'message', 'mine', 'name', 'no-hooks', 'no-jobs', 'no-parent',
  'no-skill', 'no-start', 'older', 'output', 'owner', 'parent', 'pretty', 'priority', 'project', 'reason',
  'remote', 'repo', 'resolution', 'runtimes', 'scope', 'session', 'stage', 'start', 'status', 'summary', 'tag',
  'tasks', 'title', 'to', 'type', 'url', 'version', 'visibility',
])

const REPEATABLE = new Set(['tag', 'label', 'member'])

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    if (!KNOWN_FLAGS.has(name)) {
      const near = [...KNOWN_FLAGS]
        .filter((known) => known.startsWith(name.slice(0, 3)) || name.startsWith(known.slice(0, 3)))
        .slice(0, 3)
      process.stderr.write(
        `unknown flag --${name}\n` +
          (near.length ? `did you mean ${near.map((n) => `--${n}`).join(', ')}?\n` : '') +
          `this is refused rather than ignored: a flag that is silently dropped ` +
          `returns an answer that looks filtered and is not.\n`,
      )
      process.exit(2)
    }
    const value = inline !== undefined
      ? inline
      : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    // Repeatable: `--tag a --tag b` is two tags, not the last one.
    if (REPEATABLE.has(name) && typedFlags[name] !== undefined && value !== true) {
      typedFlags[name] = [...[typedFlags[name]].flat(), value]
    } else flags[name] = value
  } else positional.push(arg)
}

const FORMAT = flags.json ? 'json' : flags.pretty ? 'pretty' : 'tsv'
// Already acted on, before parsing: they chose the instance above. --cwd is
// how any command says which directory it is about, not only context's.
void flags.instance
if (INSTANCES) void flags.cwd

/**
 * What this file actually is, as a 16-hex sha256 — the same digest
 * scripts/sync-agent-files.mjs prints, so the installer's log line and the
 * server's header are the same string for the same file.
 *
 * This is the only identifier a copied CLI can compute about itself. There is
 * no repository behind ~/.local/bin/croft and no commit recorded in it; there
 * is a file, and a file can be read. Computed at most once per process and
 * only when a server has offered something to compare against — measured at
 * 0.049 ms for the 100KB this file weighs, which is well under the cost of
 * the request that triggered it, but there is no reason to pay it twice.
 */
let ownHash
const fingerprint = () => {
  if (ownHash !== undefined) return ownHash
  try {
    const path = process.argv[1] && existsSync(process.argv[1]) ? process.argv[1] : null
    ownHash = path
      ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
      : null
  } catch {
    // Unreadable — running from a bundle, a pipe, or somewhere with no read
    // permission on itself. Nothing to compare, so nothing is said.
    ownHash = null
  }
  return ownHash
}

/**
 * Every API response says which release served it and which CLI it shipped.
 * Compare once, so a stale copy says so on the ordinary path.
 *
 * `croft --version` has always been able to answer this, but it is the one
 * command an agent has no reason to run: a drifted CLI goes on working, just
 * not the way the docs say. The Mac's copy was found only because `croft
 * vitals` happened to come back "unknown command", after a day of writes under
 * the wrong identity.
 *
 * WHY TWO COMPARISONS. The version alone almost never fires. Releases are cut
 * by hand and 133 commits fitted inside v0.5.1, so a copy months of work
 * behind still agrees on the number — which is exactly the state the Mac was
 * in when this was written, both sides saying 0.5.1 while `--allow-dangling`
 * and the vitals memory block were missing (CROFT-261). The version is still
 * the better thing to say when the two belong to different releases, because
 * it is what a human reads and what the docs are written against; the hash
 * catches everything finer, which is nearly everything.
 *
 * Silence when the server offers neither. A check that cannot run must leave
 * the CLI working, not warn on a guess.
 *
 * stderr, never stdout — callers parse stdout, and a warning in it is a bug.
 * Once per process, because the point is to be noticed, and a line repeated on
 * every request is a line nobody reads.
 */
/**
 * Which side of a drift is newer, when anything can say.
 *
 * The warning used to tell everybody to run the sync, and on the server the
 * sync is what had put the newer file there: it pulls `main` on its own clock,
 * so for a few minutes after a merge the CLI is AHEAD of the deploy, and the
 * advice was to fetch the file that was already installed (CROFT-290).
 *
 * Two orderings are available. Releases compare as numbers. Within a release
 * the server may say when it was built (`x-croft-built-at`), and this file's
 * mtime is when it was installed: a CLI written before the image it disagrees
 * with was built is the older side, and one written after it is almost always
 * a merge the deploy has not caught up with. Neither -> say so neutrally.
 */
const compareReleases = (a, b) => {
  const parse = (v) => String(v).split('.').map((part) => Number.parseInt(part, 10))
  const [x, y] = [parse(a), parse(b)]
  if ([...x, ...y].some(Number.isNaN)) return null
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1
  }
  return 0
}

const installedAt = () => {
  try {
    return process.argv[1] ? statSync(process.argv[1]).mtimeMs : null
  } catch {
    return null
  }
}

/**
 * The exact command that brings this machine's copy up to date, chosen by what
 * is installed here rather than by a guess about which host this is.
 */
const updateCommand = (newerRelease = null) => {
  // The agent-files job keeps this machine on the release `croft setup`
  // installed, so it can repair a drifted copy but never moves to another
  // release. That is the installer's job, run on purpose.
  if (newerRelease) {
    return `curl -fsSL https://raw.githubusercontent.com/montytorr/croft/main/install.sh | sh -s -- --url ${BASE}`
  }
  const home = homedir()
  const agent = join(home, 'Library/LaunchAgents/com.croft.agent-files.plist')
  if (process.platform === 'darwin' && existsSync(agent)) {
    return `launchctl kickstart gui/${process.getuid()}/com.croft.agent-files`
  }
  const own = join(home, '.croft/maintenance/install-cron.mjs')
  if (existsSync(own)) return `node ${own} --run agent-files`
  // The server's job lives in root's crontab, which is the one --run reads.
  const shared = '/opt/croft-maintenance/install-cron.mjs'
  if (existsSync(shared)) {
    return `${process.getuid?.() === 0 ? '' : 'sudo '}node ${shared} --run agent-files`
  }
  const sync = join(home, '.croft/maintenance/sync-agent-files.mjs')
  if (existsSync(sync)) {
    return `node ${sync} --source https://raw.githubusercontent.com/montytorr/croft/v${VERSION}`
  }
  return `copy cli/croft.mjs from the deployed commit over ${process.argv[1] ?? 'this file'}`
}

/** One line, or null when the two agree or the server offers nothing to compare. */
const driftLine = (headers) => {
  const version = headers?.get?.('x-croft-version')
  const servedHash = headers?.get?.('x-croft-cli')
  const builtAt = Date.parse(headers?.get?.('x-croft-built-at') ?? '')

  let detail = null
  let order = null
  if (version && version !== VERSION) {
    detail = `this CLI is ${VERSION}, ${BASE} is ${version}`
    order = compareReleases(VERSION, version)
  } else if (servedHash) {
    const mine = fingerprint()
    // Same release, different file: the case the version can never see.
    if (mine && mine !== servedHash) {
      detail = `this CLI is ${VERSION} ${mine}, ${BASE} ships ${VERSION} ${servedHash}`
      const at = installedAt()
      if (at !== null && Number.isFinite(builtAt)) order = at < builtAt ? -1 : 1
    }
  }
  if (!detail) return null

  const newerRelease = version && version !== VERSION ? version : null
  if (order === -1) return `croft: this CLI is older than the server (${detail}) — update: ${updateCommand(newerRelease)}`
  if (order === 1) {
    return (
      `croft: this CLI is newer than the server (${detail}) — probably a merge not deployed yet; ` +
      `nothing to do unless it persists`
    )
  }
  return `croft: CLI and server differ (${detail}) — if the server is newer, update: ${updateCommand(newerRelease)}`
}

let warnedStale = false
const warnIfStale = (res) => {
  if (warnedStale) return
  const line = driftLine(res?.headers)
  if (!line) return
  warnedStale = true
  process.stderr.write(`${line}\n`)
}

/**
 * A rename, said out loud (CROFT-264).
 *
 * AC was renamed HOL. Every old ref and `--project AC` went on resolving, and
 * nothing said why the answer came back as HOL — so an agent whose notes said
 * AC-113 could not tell it had the same task, and one filtering on AC could not
 * tell a renamed project from an empty one. The server now reports how it got
 * there (`requested_ref`, `renamed_from`); this says so.
 *
 * stderr, like every other advisory here: stdout is parsed, and the same facts
 * are in it already as fields for anything that parses. Once per key per
 * process, because a batch touching forty old refs needs telling once.
 */
const renameDay = (at) => (typeof at === 'string' ? at.slice(0, 10) : '?')

const renameLine = (requested, rename, ref) => {
  const by = rename.by ? ` by ${rename.by}` : ''
  if (requested && ref && requested !== ref) {
    return `${requested} is now ${ref} — project ${rename.key} was renamed ${rename.to} on ${renameDay(rename.at)}${by}. ${requested} still resolves; write ${ref}.`
  }
  return `note: project ${rename.key} is now ${rename.to} — renamed on ${renameDay(rename.at)}${by}. ${rename.key} still resolves; write ${rename.to}.`
}

const toldRenames = new Set()
const tellRename = (requested, rename, ref) => {
  if (!rename?.key || !rename?.to) return
  const id = `${requested ?? ''}|${rename.key}`
  if (toldRenames.has(id)) return
  toldRenames.add(id)
  process.stderr.write(`${renameLine(requested, rename, ref)}\n`)
}

/** `-` means read the value from stdin, so long markdown bodies stay off argv. */
const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}
const resolveValue = async (v) => (v === '-' ? (await readStdin()).trim() : v)

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
/**
 * Gateway errors are transient and worth waiting out.
 *
 * A deploy takes the app down for a few seconds, and during that window every
 * call returns 502 from the proxy. That is survivable for a human retrying by
 * hand and fatal for a batch import or a session-end hook, which gets one
 * chance to record what happened before the session is gone.
 */
const TRANSIENT = new Set([502, 503, 504])
const RETRIES = 3

/**
 * How long a write may spend being retried before it is put aside instead.
 *
 * Writes normally return in about half a second. During a deploy the container
 * is down and they block for minutes — several `croft add` calls ran past 120s
 * and 300s, every one of them while a container was restarting. Retrying is
 * right; making an agent mid-task wait for a restart is not. Croft is supposed
 * to be the thing an agent can always write to.
 */
const DEADLINE_MS = Number(process.env.CROFT_DEADLINE_MS ?? 15_000)

/** Guards against a replay triggering its own replay. */
let FLUSHING = false

/**
 * The outbox, and what is allowed into it.
 *
 * Only writes whose answer the caller does not need: a note, a comment, a
 * heartbeat, a checkpoint. `add` and `claim` are deliberately excluded — an
 * agent that is handed a ref which does not exist yet, or told it holds a task
 * it may not have won, is worse off than one told plainly that the write
 * failed. Those fail fast instead.
 */
const OUTBOX_PATH = join(STATE_DIR, 'outbox.jsonl')
const REJECTED_OUTBOX_PATH = `${OUTBOX_PATH}.rejected`
const OUTBOX_LOCK_PATH = `${OUTBOX_PATH}.lock`
const OUTBOX_REPLAY_LOCK_PATH = `${OUTBOX_PATH}.replay.lock`
const OUTBOX_PREFIX = 'outbox.jsonl.'
const QUEUEABLE = /\/(notes|comments|beat|checkpoint)$/
const KEY_ID = KEY ? createHash('sha256').update(KEY).digest('hex').slice(0, 24) : ''
const TEST_CRASH_AFTER_SEND = process.env.CROFT_TEST_CRASH_AFTER_SEND === '1'
const TEST_FAIL_PERSIST_AFTER_SEND = process.env.CROFT_TEST_FAIL_PERSIST_AFTER_SEND === '1'
const TEST_CRASH_AFTER_RENAME_BEFORE_STATE = process.env.CROFT_TEST_CRASH_AFTER_RENAME_BEFORE_STATE === '1'
const TEST_FAIL_REJECT_PERSIST = process.env.CROFT_TEST_FAIL_REJECT_PERSIST === '1'
const TEST_ENQUEUE_DURING_REPLAY = process.env.CROFT_TEST_ENQUEUE_DURING_REPLAY ?? ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Put a write aside so the agent can carry on, and say so plainly. */
const withOutboxLock = async (run) => {
  mkdirSync(dirname(OUTBOX_PATH), { recursive: true })
  const deadline = Date.now() + Math.max(DEADLINE_MS, 5_000)
  let handle
  while (handle === undefined) {
    try {
      handle = openSync(OUTBOX_LOCK_PATH, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(OUTBOX_LOCK_PATH).mtimeMs > Math.max(DEADLINE_MS * 4, 60_000)) {
          unlinkSync(OUTBOX_LOCK_PATH)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) throw new Error('timed out waiting for the outbox lock')
      await sleep(20)
    }
  }
  try {
    return await run()
  } finally {
    closeSync(handle)
    try { unlinkSync(OUTBOX_LOCK_PATH) } catch { /* stale recovery may already have removed it */ }
  }
}

/** PID alone is reusable; include the OS process incarnation in a replay lease. */
const processStartIdentity = (pid) => {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      if (!boot || !/^\d+$/.test(fields[19] ?? '')) return null
      return `${boot}:${fields[19]}` // /proc stat field 22: starttime
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() || null
    }
  } catch { /* inaccessible or no longer running */ }
  return null
}

/** Legacy pid-token leases have no start identity. Reclaim only when the live
 * PID is demonstrably not a Croft CLI process; an unreadable command is unknown. */
const isUnrelatedToCroft = (pid) => {
  try {
    const command = process.platform === 'linux'
      ? readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
      : process.platform === 'darwin'
        ? execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
        : ''
    return Boolean(command.trim()) && !/(?:^|[\s/])croft(?:\.mjs)?(?:\s|$)/.test(command)
  } catch { return false }
}

/** One worker drains the shared queue at a time, including its network sends. */
const withReplayLock = async (run) => {
  mkdirSync(dirname(OUTBOX_PATH), { recursive: true })
  const deadline = Date.now() + Math.max(DEADLINE_MS * 2, 5_000)
  const owner = JSON.stringify({ pid: process.pid, start: processStartIdentity(process.pid), token: randomUUID() })
  let handle
  while (handle === undefined) {
    // The short append lock serializes contenders recovering and replacing a
    // dead lease. It is released before any network request, so enqueues keep
    // flowing while one worker drains.
    handle = await withOutboxLock(() => {
      try {
        const opened = openSync(OUTBOX_REPLAY_LOCK_PATH, 'wx', 0o600)
        try { writeFileSync(opened, owner) } catch (error) { closeSync(opened); throw error }
        return opened
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          const current = readFileSync(OUTBOX_REPLAY_LOCK_PATH, 'utf8')
          let lease
          try { lease = JSON.parse(current) } catch { lease = { pid: Number(current.split('-')[0]) } }
          const pid = lease.pid
          let dead = false
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0)
              // A live, unrelated process may have reused this PID. If its
              // start identity differs, the original lease owner is gone.
              const actualStart = processStartIdentity(pid)
              dead = lease.start
                ? Boolean(actualStart && lease.start !== actualStart)
                : isUnrelatedToCroft(pid)
            } catch (checkError) { dead = checkError?.code === 'ESRCH' }
          } else {
            // A crash between exclusive creation and writing the owner leaves
            // an empty file. Never reclaim a freshly created one.
            dead = Date.now() - statSync(OUTBOX_REPLAY_LOCK_PATH).mtimeMs > Math.max(DEADLINE_MS * 4, 60_000)
          }
          if (dead) unlinkSync(OUTBOX_REPLAY_LOCK_PATH)
        } catch { /* another worker may have released the lease */ }
        return undefined
      }
    })
    if (handle === undefined) {
      if (Date.now() >= deadline) throw new Error(
        `timed out waiting for the outbox replay lock; inspect its PID owner before manually removing ${OUTBOX_REPLAY_LOCK_PATH}`,
      )
      await sleep(20)
    }
  }
  try {
    return await run()
  } finally {
    closeSync(handle)
    try {
      await withOutboxLock(() => {
        if (readFileSync(OUTBOX_REPLAY_LOCK_PATH, 'utf8') === owner) unlinkSync(OUTBOX_REPLAY_LOCK_PATH)
      })
    } catch { /* the lease was already recovered */ }
  }
}

const enqueue = async (method, path, body, why) => {
  try {
    await withOutboxLock(() => {
      if (path.split('?')[0].endsWith('/checkpoint')) {
        const state = rememberedTaskState(path)
        if (state) body = {
          ...body,
          ownershipVersion: state.ownershipVersion,
          checkpointVersion: state.checkpointVersion + pendingCheckpointCount(path, state.ownershipVersion),
        }
      }
      const item = {
        id: randomUUID(),
        t: new Date().toISOString(),
        method,
        path,
        body,
        agent: AGENT,
        base: BASE,
        keyId: KEY_ID,
      }
      appendFileSync(OUTBOX_PATH, `${JSON.stringify(item)}\n`, { mode: 0o600 })
    })
  } catch (error) {
    die(`${why}, and it could not be queued either: ${error.message}`)
  }
  process.stderr.write(`${why} — queued locally, replays on the next successful write\n`)
  return { queued: true, path }
}

const FOREIGN_OUTBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Whose queued write this is, decided before anything is sent.
 *
 * One outbox serves every runtime on the machine, so a write Claude Code
 * queued is routinely found by a Codex process draining after its own
 * success. That is not a mismatch to punish: it is somebody else's write, and
 * it waits for its own runtime. Only a write this runtime queued under a key
 * it no longer holds is refused — replaying it under the new key would sign
 * it with an identity that did not make it.
 */
const replayContext = (item) => {
  if (!item.id) return 'no id'
  if (item.base !== BASE || item.agent !== AGENT) {
    const age = Date.now() - Date.parse(item.t)
    // No readable queued-at time would otherwise keep it forever.
    if (!Number.isFinite(age)) return 'no queued-at time'
    return age > FOREIGN_OUTBOX_TTL_MS
      ? 'no process for its runtime and instance replayed it in 30 days'
      : 'foreign'
  }
  return item.keyId === KEY_ID ? 'own' : 'queued under a key this runtime no longer uses'
}

/** A crashed replay worker must not strand its claimed file for a minute. */
const processingOwnerIsDead = (name) => {
  const pid = Number(new RegExp(`^${OUTBOX_PREFIX.replaceAll('.', '\\.') }processing-(\\d+)-`).exec(name)?.[1])
  if (!Number.isSafeInteger(pid) || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * Whether a queue file holds anything this process would act on. Another
 * runtime's writes can wait here for days; draining them just to put them back
 * would turn every write and every checkpoint into a full replay cycle.
 */
const holdsReplayable = (path) => {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).some((line) => {
      try {
        return replayContext(JSON.parse(line)) !== 'foreign'
      } catch {
        return true // quarantined by replay
      }
    })
  } catch {
    return false
  }
}

const hasReplayableOutbox = () => {
  try {
    const dir = dirname(OUTBOX_PATH)
    return readdirSync(dir).some((name) =>
      ((name === basename(OUTBOX_PATH) || name.startsWith(`${OUTBOX_PREFIX}pending-`)) &&
        holdsReplayable(join(dir, name))) ||
      (name.startsWith(`${OUTBOX_PREFIX}processing-`) && !name.endsWith('.tmp') && !name.endsWith('.ack')) ||
      name.startsWith(`${OUTBOX_PREFIX}ack-`),
    )
  } catch {
    return false
  }
}

/**
 * Send everything that was put aside, oldest first.
 *
 * Stops at the first transient failure and keeps the rest: the server is still
 * coming back, and draining into a restarting container would lose the queue
 * for the same reason it was written. A write the server actively rejects is
 * moved to a rejected sidecar with the response, never silently discarded.
 */
const flushOutbox = async () => withReplayLock(async () => {
  requireKey()
  let sent = 0
  let rejected = 0
  let waiting = 0
  const claimId = `${process.pid}-${randomUUID()}`
  let claimed = []
  try {
    claimed = await withOutboxLock(() => {
      const dir = dirname(OUTBOX_PATH)
      // Recover acknowledgements journaled before a crash between processing
      // file compaction and local ownership persistence.
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${OUTBOX_PREFIX}ack-`) || !name.endsWith('.json')) continue
        const path = join(dir, name)
        try {
          const marker = JSON.parse(readFileSync(path, 'utf8'))
          if (updateRememberedOwnership(marker.path, marker.data)) rmSync(path, { force: true })
        } catch { /* retain the marker for the next recovery attempt */ }
      }
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${OUTBOX_PREFIX}processing-`)) continue
        if (name.endsWith('.ack') || name.endsWith('.tmp')) continue
        const path = join(dir, name)
        try {
          if (
            processingOwnerIsDead(name) ||
            Date.now() - statSync(path).mtimeMs > Math.max(DEADLINE_MS * 4, 60_000)
          ) {
            renameSync(path, join(dir, `${OUTBOX_PREFIX}pending-${randomUUID()}`))
          }
        } catch { /* another recovery won the rename */ }
      }
      if (existsSync(OUTBOX_PATH) && statSync(OUTBOX_PATH).size > 0) {
        renameSync(OUTBOX_PATH, join(dir, `${OUTBOX_PREFIX}pending-${randomUUID()}`))
      }
      const paths = []
      for (const name of readdirSync(dir)) {
        if (!name.startsWith(`${OUTBOX_PREFIX}pending-`)) continue
        const from = join(dir, name)
        const to = join(dir, `${OUTBOX_PREFIX}processing-${claimId}-${randomUUID()}`)
        try {
          renameSync(from, to)
          paths.push(to)
        } catch { /* another replay process claimed it */ }
      }
      return paths
    })
  } catch {
    return { sent: 0, rejected: 0, left: existsSync(OUTBOX_PATH) ? 1 : 0, waiting: 0 }
  }

  const reject = (entry) => {
    if (TEST_FAIL_REJECT_PERSIST) throw new Error('test failpoint: rejected-sidecar persistence failed')
    appendFileSync(REJECTED_OUTBOX_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    rejected += 1
  }

  // Use the enqueue timestamp rather than directory order or the shard mtime:
  // a failed older shard is compacted back into the live outbox, changing mtime.
  const queuedAt = (path) => {
    try {
      const first = readFileSync(path, 'utf8').split('\n').find(Boolean)
      const at = first ? Date.parse(JSON.parse(first).t ?? '') : NaN
      if (Number.isFinite(at)) return at
    } catch { /* fall back to the shard's filesystem timestamp */ }
    try { return statSync(path).mtimeMs } catch { return Infinity }
  }
  const orderedClaimed = [...claimed].sort((a, b) => {
    return queuedAt(a) - queuedAt(b) || a.localeCompare(b)
  })
  let haltDrain = false
  for (const processingPath of orderedClaimed) {
    let lines
    try {
      lines = readFileSync(processingPath, 'utf8').split('\n').filter(Boolean)
    } catch {
      haltDrain = true
      break
    }
    const kept = []
    let index = 0
    for (; index < lines.length; index += 1) {
    let item
    try {
      item = JSON.parse(lines[index])
    } catch {
      try {
        reject({ rejectedAt: new Date().toISOString(), reason: 'invalid JSON', raw: lines[index] })
      } catch {
        haltDrain = true
        break
      }
      continue
    }
    const context = replayContext(item)
    if (context === 'foreign') {
      kept.push(lines[index])
      waiting += 1
      continue
    }
    if (context !== 'own') {
      try {
        reject({ rejectedAt: new Date().toISOString(), reason: `replay context mismatch: ${context}`, item })
      } catch {
        haltDrain = true
        break
      }
      continue
    }
    let res
    try {
      res = await fetch(`${BASE}${item.path}`, {
        method: item.method,
        headers: authHeaders({
          'Content-Type': 'application/json',
          'Idempotency-Key': item.id,
          'X-Croft-Queued-At': item.t,
        }),
        body: item.body === undefined ? undefined : JSON.stringify(item.body),
      })
    } catch {
      haltDrain = true
      break // still unreachable
    }
    if (TRANSIENT.has(res.status)) {
      haltDrain = true
      break
    }
    let response = ''
    try {
      response = await res.text()
    } catch {
      response = '<response unavailable>'
    }
    let acknowledgedData = null
    if (res.ok) {
      sent += 1
      try {
        const payload = JSON.parse(response)
        if (payload?.success) acknowledgedData = payload.data
      } catch { /* a successful legacy endpoint may have no JSON body */ }
      if (TEST_CRASH_AFTER_SEND) process.kill(process.pid, 'SIGKILL')
    } else {
      try {
        reject({ rejectedAt: new Date().toISOString(), status: res.status, response: response.slice(0, 2_000), item })
      } catch {
        haltDrain = true
        break
      }
    }
    const remaining = [...kept, ...lines.slice(index + 1)]
    const temp = `${processingPath}.tmp`
    if (TEST_FAIL_PERSIST_AFTER_SEND) throw new Error('test failpoint: replay persistence failed')
    const isCheckpoint = item.path.split('?')[0].endsWith('/checkpoint')
    const ackPath = `${OUTBOX_PREFIX}ack-${randomUUID()}.json`
    if (acknowledgedData && isCheckpoint) {
      writeFileSync(join(dirname(OUTBOX_PATH), ackPath), `${JSON.stringify({ path: item.path, data: acknowledgedData })}\n`, { mode: 0o600 })
    }
    writeFileSync(temp, remaining.length ? `${remaining.join('\n')}\n` : '', { mode: 0o600 })
    renameSync(temp, processingPath)
    if (TEST_CRASH_AFTER_RENAME_BEFORE_STATE && acknowledgedData && isCheckpoint) process.kill(process.pid, 'SIGKILL')
    // Advance local checkpoint state only after the acknowledged record has
    // been durably removed from the processing file. Otherwise a local
    // persistence failure leaves a phantom sequence gap for the next queue.
    if (acknowledgedData && isCheckpoint && updateRememberedOwnership(item.path, acknowledgedData)) {
      rmSync(join(dirname(OUTBOX_PATH), ackPath), { force: true })
    }
  }

    const left = [...kept, ...lines.slice(index)]
    if (left.length > 0) {
      try {
        // In front of whatever was queued while this replay ran: those are
        // newer, and a checkpoint sent ahead of an older one breaks its sequence.
        await withOutboxLock(() => {
          if (TEST_ENQUEUE_DURING_REPLAY) appendFileSync(OUTBOX_PATH, `${TEST_ENQUEUE_DURING_REPLAY}\n`, { mode: 0o600 })
          let newer = ''
          try { newer = readFileSync(OUTBOX_PATH, 'utf8') } catch { /* nothing queued meanwhile */ }
          const temp = `${OUTBOX_PATH}.requeue.tmp`
          writeFileSync(temp, `${left.join('\n')}\n${newer}`, { mode: 0o600 })
          renameSync(temp, OUTBOX_PATH)
        })
      } catch {
        haltDrain = true
        break
      }
    }
    rmSync(processingPath, { force: true })
    if (haltDrain) break
  }

  let left = 0
  try { left = readFileSync(OUTBOX_PATH, 'utf8').split('\n').filter(Boolean).length } catch { /* empty */ }
  for (const path of claimed) if (existsSync(path)) {
    try { left += readFileSync(path, 'utf8').split('\n').filter(Boolean).length } catch { /* retry later */ }
  }
  return { sent, rejected, left, waiting }
})

/**
 * Set by the first non-GET request. Read only by the ignored-flag report,
 * which has to know whether failing is safe: a read that ignored a filter
 * returned an answer nobody should trust and has done nothing, so exiting
 * non-zero is free. A write that ignored a flag has already happened, and
 * exiting non-zero would invite a caller to retry it.
 */
let mutated = false

/**
 * Keep this instance's list of project keys fresh enough to route a ref by
 * (resolveRoute). Only this instance's own server is asked, with its own key,
 * after it has already answered; at most every six hours, or at once after a
 * project was created or rekeyed. A failure keeps the old list.
 */
let refreshingKeys = false
const refreshProjectKeys = async (force) => {
  if (!INSTANCE.name || refreshingKeys) return
  const path = join(STATE_DIR, PROJECT_KEYS_FILE)
  try {
    if (!force && Date.now() - statSync(path).mtimeMs < PROJECT_KEYS_TTL_MS) return
  } catch { /* never fetched */ }
  refreshingKeys = true
  try {
    // Active projects only, with the keys they used to have. An archived
    // project is history: when a project moves to another instance, the copy
    // left behind is archived, and it must not keep claiming the moved refs.
    const res = await fetch(`${BASE}/api/v1/projects`, {
      headers: authHeaders(),
      // A hint, so never allowed to hold up the answer longer than the answer itself could.
      signal: AbortSignal.timeout(Math.min(DEADLINE_MS, 3_000)),
    })
    const payload = await res.json()
    if (!payload?.success || !Array.isArray(payload.data)) return
    const keys = [...new Set(payload.data.flatMap((p) => [p.key, ...(p.former_keys ?? []).map((f) => f.key)]).filter(Boolean))]
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ at: new Date().toISOString(), keys })}\n`, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  } catch {
    // A routing hint, never worth failing the command that earned it.
  } finally {
    refreshingKeys = false
  }
}

const request = async (method, path, body, { soft = false, onError } = {}) => {
  requireKey()
  if (method !== 'GET') mutated = true
  const isCheckpoint = path.split('?')[0].endsWith('/checkpoint')
  // A fresh checkpoint must not jump ahead of older durable checkpoints. Drain
  // first so the remembered sequence advances before this request is formed.
  if (!FLUSHING && isCheckpoint && hasReplayableOutbox()) {
    FLUSHING = true
    try { await flushOutbox() } finally { FLUSHING = false }
  }
  const taskState = rememberedTaskState(path)
  if (taskState && body && typeof body === 'object') {
    body = { ...body, ownershipVersion: taskState.ownershipVersion }
    if (isCheckpoint) body.checkpointVersion = taskState.checkpointVersion
  }
  let res
  const startedAt = Date.now()
  const spent = () => Date.now() - startedAt

  // A write that cannot get through is put aside rather than waited on. Only
  // ones whose answer the caller does not need; everything else fails fast,
  // which is still far better than blocking for minutes.
  const giveUp = (why) => {
    if (method !== 'GET' && QUEUEABLE.test(path.split('?')[0])) {
      if (path.split('?')[0].endsWith('/checkpoint') && rememberedOwnership(path) === null) {
        die(`${why}; checkpoint cannot be queued without a known ownership generation`)
      }
      return enqueue(method, path, body, why)
    }
    die(`${why} (${Math.round(spent() / 1000)}s)`)
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      if (attempt >= RETRIES || spent() > DEADLINE_MS) {
        return giveUp(`cannot reach ${BASE}: ${error.message}`)
      }
      await sleep(500 * 2 ** attempt)
      continue
    }
    if (TRANSIENT.has(res.status)) {
      if (attempt >= RETRIES || spent() > DEADLINE_MS) {
        return giveUp(`${BASE} returned ${res.status} — it is probably restarting`)
      }
      await sleep(500 * 2 ** attempt)
      continue
    }
    break
  }

  warnIfStale(res)

  const text = await res.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    if (soft) return null
    die(`non-JSON response (${res.status}): ${text.slice(0, 200)}`)
  }

  if (!payload.success) {
    // A caller that can say something better about one refusal says it.
    if (onError) onError(payload, res.status)
    // `soft` callers are probing, not asserting: a miss is an answer.
    if (soft) return null
    // Surface the server's guidance verbatim — it names valid enum values and,
    // on a refused close, suggests a resolution. Swallowing that would turn a
    // useful round-trip into a wasted one.
    // A refused write names what it could not resolve. Printing only
    // `error` would hand back "some references did not resolve" and drop the
    // list of what they were and what the store actually calls them.
    const refs = [
      ...(payload.unresolvedReferences ?? []).map(
        (r) => `  [[${r.ref ?? r}]]${r.suggestions?.length ? ` — did you mean ${r.suggestions.join(', ')}?` : ''}`,
      ),
      ...(payload.taskReferences ?? []).map((r) => `  [[${r}]] is a task ref — write it bare as ${String(r).toUpperCase()}`),
    ]
    // A refused body lists what to fix. The server puts the list in `error`
    // too, for clients that print nothing else; this covers one that does not.
    const problems = (payload.problems ?? []).filter((p) => !String(payload.error).includes(p))
    const extra = refs.length
      ? `\n${refs.join('\n')}`
      : problems.length
      ? `\n${problems.map((p) => `  - ${p}`).join('\n')}`
      : payload.suggestedResolution
      ? `\nsuggested: ${payload.suggestedResolution}`
      : payload.issues
        ? `\n${payload.issues
            .map((i) => `  ${(i.path ?? []).join('.') || '(body)'}: ${i.message}`)
            .join('\n')}`
        : ''
    // The server names the rule and the line, never the value (CROFT-285).
    // What to do instead is the part worth adding.
    const hint = payload.code === 'secret_detected'
      ? '\n  write where it lives instead: `$ENV_VAR`, `process.env.X`, a vault path, or `<password>`.' +
        '\n  if it was a real credential, rotate it: it has already been in this transcript.'
      : ''
    // Some 409s get their own exit code so a caller can branch on them:
    // "someone else has it", and "that session is already closed" (the
    // session hook stops checkpointing it, CROFT-319).
    die(`${payload.error}${extra}${hint}`, EXIT_CODES[payload.code] ?? 1)
  }

  // Any response reached through a retired key says so here, once, rather than
  // each verb remembering to — the gap CROFT-264 was, verb by verb.
  const told = payload.data
  if (told && typeof told === 'object' && !Array.isArray(told) && told.renamed_from) {
    tellRename(told.requested_ref, told.renamed_from, refOfTask(told))
  }

  await refreshProjectKeys(method !== 'GET' && path.startsWith('/api/v1/projects'))

  // Recorded here rather than at each call site: one place that already knows
  // the method, the path and that the server said yes.
  if (method !== 'GET') {
    updateRememberedOwnership(path, payload.data)
    // The server just answered, so anything put aside while it was down can go
    // now. No cron and nothing to remember to run: the next write drains it.
    if (!FLUSHING && hasReplayableOutbox()) {
      FLUSHING = true
      try {
        const { sent } = await flushOutbox()
        if (sent > 0) process.stderr.write(`replayed ${sent} queued write(s)\n`)
      } finally {
        FLUSHING = false
      }
    }
  }
  return payload.data
}

/**
 * The server validates against a MIME allowlist, and a Blob with no `type`
 * arrives as application/octet-stream — so every legitimate upload would be
 * rejected. Node has no mime lookup built in, so infer from the extension.
 */
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  html: 'text/html', htm: 'text/html',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', zip: 'application/zip', tar: 'application/x-tar',
  gz: 'application/gzip', mp4: 'video/mp4', mp3: 'audio/mpeg',
}

const mimeOf = (filePath) => {
  const ext = filePath.toLowerCase().split('.').pop()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

const upload = async (path, filePath) => {
  requireKey()
  if (!existsSync(filePath)) die(`no such file: ${filePath}`)

  const form = new FormData()
  // Let fetch set the multipart boundary; do not send a Content-Type header.
  form.append('file', new Blob([readFileSync(filePath)], { type: mimeOf(filePath) }), basename(filePath))

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  }).catch((error) => die(`cannot reach ${BASE}: ${error.message}`))

  const payload = await res.json().catch(() => null)
  if (!payload?.success) {
    die(payload?.error ?? `upload failed with ${res.status}`)
  }
  return payload.data
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
const flatten = (value, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(value ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v === null || v === undefined || v === '') continue // omit nulls entirely
    if (Array.isArray(v)) {
      if (!v.length) continue
      // An array of objects joined with a comma is a row of "[object Object]".
      // Index them instead, so `findings.0.note` is readable and greppable.
      if (v.some((item) => item && typeof item === 'object')) {
        v.forEach((item, i) => flatten(item, `${key}.${i}`, out))
      } else {
        out[key] = v.join(',')
      }
    } else if (typeof v === 'object') flatten(v, key, out)
    else out[key] = String(v)
  }
  return out
}

const emit = (data, opts = {}) => {
  if (FORMAT === 'json') return console.log(JSON.stringify(data, null, 2))
  if (FORMAT === 'pretty') return console.log(JSON.stringify(data, null, 2))

  // Some answers are sentences, not a table. Forcing them through the
  // key/value flattener turns a finding worth reading into nine numbered rows
  // nobody reads.
  if (opts.lines) {
    for (const line of opts.lines(data)) console.log(line)
    return
  }

  const rows = opts.rows ? opts.rows(data) : Array.isArray(data) ? data : null
  if (!rows) {
    const flat = flatten(data)
    for (const [k, v] of Object.entries(flat)) console.log(`${k}\t${v}`)
    return
  }

  console.log(`#${rows.length}`) // count first: paginate before parsing
  if (rows.length === 0) return
  const flatRows = rows.map((r) => flatten(r))
  const cols = opts.columns ?? [...new Set(flatRows.flatMap((r) => Object.keys(r)))]
  console.log(cols.join('\t'))
  for (const r of flatRows) console.log(cols.map((c) => r[c] ?? '').join('\t'))
}

/** Comma or repeated-flag list, e.g. --label a,b --label c. */
/**
 * Which Croft project a directory belongs to.
 *
 * The server can guess from sessions already recorded against a cwd, but only
 * after the first one. This is the explicit answer, kept next to the
 * credentials: a longest-prefix map in ~/.croft/projects.json, so a monorepo
 * subdirectory can override its parent.
 */
const PROJECT_MAP_PATH = join(STATE_DIR, 'projects.json')
const OWNERSHIP_DIR = join(STATE_DIR, 'ownership')

const ownershipPath = (ref) => join(OWNERSHIP_DIR, `${ref.toUpperCase().replace(/[^A-Z0-9-]/g, '_')}.json`)

const rememberedTaskState = (path) => {
  const raw = /\/api\/v1\/tasks\/([^/?]+)\/(?:beat|checkpoint|release)$/.exec(path)?.[1]
  if (!raw) return null
  try {
    const value = JSON.parse(readFileSync(ownershipPath(decodeURIComponent(raw)), 'utf8'))
    if (!Number.isSafeInteger(value?.ownershipVersion)) return null
    return {
      ownershipVersion: value.ownershipVersion,
      checkpointVersion: Number.isSafeInteger(value?.checkpointVersion) ? value.checkpointVersion : 0,
    }
  } catch {
    return null
  }
}

const rememberedOwnership = (path) => rememberedTaskState(path)?.ownershipVersion ?? null

/** Count earlier durable checkpoints so each queued write reserves one sequence. */
const pendingCheckpointCount = (path, ownershipVersion) => {
  const endpoint = path.split('?')[0]
  let count = 0
  try {
    const dir = dirname(OUTBOX_PATH)
    const names = readdirSync(dir).filter((name) =>
      name === basename(OUTBOX_PATH) ||
      name.startsWith(`${OUTBOX_PREFIX}pending-`) ||
      (name.startsWith(`${OUTBOX_PREFIX}processing-`) && !name.endsWith('.tmp')),
    )
    for (const name of names) {
      let lines = []
      try { lines = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean) } catch { continue }
      for (const line of lines) {
        try {
          const item = JSON.parse(line)
          if (
            item.base === BASE &&
            item.agent === AGENT &&
            item.path?.split('?')[0] === endpoint &&
            item.body?.ownershipVersion === ownershipVersion
          ) count += 1
        } catch { /* malformed records are quarantined by replay */ }
      }
    }
  } catch { /* no outbox yet */ }
  return count
}

const updateRememberedOwnership = (path, data) => {
  const match = /\/api\/v1\/tasks\/([^/?]+)\/(claim|checkpoint|release)$/.exec(path)
  if (!match) return false
  const target = ownershipPath(decodeURIComponent(match[1]))
  try {
    mkdirSync(OWNERSHIP_DIR, { recursive: true })
    if (match[2] === 'release') { rmSync(target, { force: true }); return true }
    const version = Number(data?.ownership_version)
    const checkpointVersion = Number(data?.checkpoint_version)
    if (!Number.isSafeInteger(version)) return false
    const temp = `${target}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({
      ownershipVersion: version,
      checkpointVersion: Number.isSafeInteger(checkpointVersion) ? checkpointVersion : 0,
      agent: AGENT,
    })}\n`, { mode: 0o600 })
    renameSync(temp, target)
    return true
  } catch {
    // The server remains authoritative. Missing local context makes an offline
    // checkpoint fail closed instead of guessing an ownership generation.
    return false
  }
}

/** HOL-113 from a full task row or a digest, whichever this is. */
const refOfTask = (data) => {
  if (typeof data?.ref === 'string') return data.ref
  const key = data?.project?.key ?? data?.projects?.key
  return key && data?.number !== undefined ? `${key}-${data.number}` : undefined
}

/**
 * Mappings that name a key the project no longer has.
 *
 * They keep working — the server resolves a retired key — but every briefing
 * and `next` from that directory then goes through the old name, and an agent
 * reading "[AC]" files new work under a key that no longer exists as far as
 * anyone else can see (CROFT-264). One soft call, so an older server or a
 * network failure leaves `croft map` exactly as it was.
 */
const warnRetiredMappings = async (map) => {
  const keys = new Set(Object.values(map))
  if (keys.size === 0) return
  const projects = await request('GET', '/api/v1/projects?archived=1', undefined, { soft: true })
  if (!Array.isArray(projects)) return
  const liveFor = new Map()
  for (const p of projects) for (const f of p.former_keys ?? []) liveFor.set(f.key, { to: p.key, at: f.retired_at })
  for (const [path, k] of Object.entries(map)) {
    const now = liveFor.get(k)
    if (!now) continue
    process.stderr.write(
      `warning: ${path} is mapped to ${k}, which was renamed ${now.to} on ${renameDay(now.at)}. ` +
        `It still resolves; run \`croft map ${now.to}\` there to update it.\n`,
    )
  }
}

const readProjectMap = () => {
  try {
    return JSON.parse(readFileSync(PROJECT_MAP_PATH, 'utf8'))
  } catch {
    return {}
  }
}

const projectForDir = (dir) => {
  const map = readProjectMap()
  let best = null
  for (const [path, key] of Object.entries(map)) {
    if ((dir === path || dir.startsWith(`${path}/`)) && (!best || path.length > best[0].length)) {
      best = [path, key]
    }
  }
  return best?.[1] ?? null
}

const git = (dir, args) => {
  try {
    return (
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    return null
  }
}

const gitRoot = (dir) => git(dir, ['rev-parse', '--show-toplevel'])

/**
 * The repository this directory belongs to, as the server will know it.
 *
 * `origin` because that is what a clone writes. Sent raw: reducing spellings
 * to one repository is the server's rule, so the CLI, the MCP facade and an
 * import cannot drift apart on it.
 */
const gitRemote = (dir) => git(dir, ['remote', 'get-url', 'origin'])

/**
 * Deliberately not read on the resolution path: `rev-list --max-parents=0`
 * walks the whole history, which is milliseconds here and seconds on a large
 * repository, and the briefing hook can afford neither.
 */
const gitRootCommit = (dir) => git(dir, ['rev-list', '--max-parents=0', 'HEAD'])?.split('\n').pop()

const splitList = (v) => {
  if (v === undefined || v === true) return []
  const parts = Array.isArray(v) ? v : [v]
  return parts.flatMap((p) => String(p).split(',')).map((x) => x.trim()).filter(Boolean)
}

/**
 * The briefing, as text a model reads once at the top of a session.
 *
 * Ordered by what changes behaviour soonest: what you are still holding, then
 * what is moving around you, then where the last session stopped, then what is
 * known here. Anything with nothing to say prints nothing at all -- an empty
 * heading is noise that trains the reader to skip the block.
 */
const renderContext = (d, { fileOnly = false } = {}) => {
  const out = []

  // A file read is a narrow question. Answering it with the whole project
  // briefing, on every Read, is how an injection channel becomes noise the
  // reader learns to skip -- and then the one time it matters, it is skipped.
  if (fileOnly) {
    const f = d.file
    if (!f?.tasks?.length) return ''
    out.push(`## Croft knows about ${f.path}`)
    for (const t of f.tasks) {
      out.push(`  ${t.ref}  ${t.status}${t.resolved ? ' (answered)' : ''}  ${truncate(t.title, 54)}`)
    }
    return `${out.join('\n')}\n`
  }

  const where = d.project ? `[${d.project}]` : '[unfiled]'
  out.push(`## Croft ${where}`)

  // This checkout is mapped to a key the project no longer has. The briefing
  // is for the live project either way; saying so is what stops the next agent
  // filing "AC-…" refs into its notes for another month.
  if (d.projectRenamed) {
    const r = d.projectRenamed
    out.push(
      `  ${r.key} was renamed ${r.to} on ${renameDay(r.at)} -- ${r.key}-n refs still resolve; ` +
        `write ${r.to}-n, and run \`croft map ${r.to}\` here to update this checkout.`,
    )
  }

  if (d.held?.length) {
    out.push('', 'You are holding:')
    for (const t of d.held) {
      const quiet = t.quiet ? '  <- no note in 24h; checkpoint or release it' : ''
      // A recent rename, beside the ref it changed: the agent that wrote
      // AC-113 in yesterday's notes must recognise HOL-113 as the same task.
      const was = t.was?.length ? ` (was ${t.was.join(', ')})` : ''
      out.push(`  ${t.ref}${was}  ${t.status}  ${truncate(t.title, 58)}${quiet}`)
    }
  }

  if (d.inFlight?.length) {
    // Separated on purpose. "In flight" reads as work someone is on, and a
    // dropped task sitting in that list looked exactly like a live one --
    // which is how ten of them accumulated without anyone noticing.
    const live = d.inFlight.filter((t) => !t.stalled)
    const stalled = d.inFlight.filter((t) => t.stalled)
    // Named only when it is somebody else's: an agent should not pick up
    // Julien's dropped work thinking it is its own human's (CROFT-310).
    const whose = (t) => (t.assignee ? ` · ${t.assignee}'s` : '')

    if (live.length) {
      out.push('', 'In flight here:')
      for (const t of live) {
        const who = t.claimedBy ? `  (${t.claimedBy})` : ''
        out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 52)}${who}${whose(t)}`)
      }
    }

    if (stalled.length) {
      out.push('', 'Started and dropped here -- nobody is on these:')
      for (const t of stalled) {
        out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 44)}  quiet ${t.quietFor}${whose(t)}`)
      }
      out.push('  Finish one and close it with a resolution, or move it back to todo.')
    }
  }

  // Work that is the reader's human's and that no agent holds: without this
  // it surfaces only when somebody thinks to ask for it.
  if (d.unattended?.tasks?.length) {
    out.push('', 'Assigned to you, nobody on it:')
    for (const t of d.unattended.tasks) {
      const pressing = t.priority === 'urgent' || t.priority === 'high' ? `  [${t.priority}]` : ''
      out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 52)}${pressing}`)
    }
    if (d.unattended.more > 0) {
      // `next` rather than `list`: list includes closed work, and the question
      // this answers is which of them to pick up.
      out.push(`  +${d.unattended.more} more -- croft next --assignee me`)
    }
  }

  if (d.staleClaims?.length) {
    out.push('', 'Stale claims (lease expired, takeable):')
    for (const t of d.staleClaims) out.push(`  ${t.ref}  held ${t.heldFor} by ${t.claimedBy}`)
  }

  if (d.file) {
    const f = d.file
    if (f.tasks?.length) {
      out.push('', `About ${f.path}:`)
      for (const t of f.tasks) out.push(`  ${t.ref}  ${t.status}  ${truncate(t.title, 56)}`)
    }
  }

  if (out.length === 1) return ''
  out.push('', ...BRIEFING_RULES)
  return `${out.join('\n')}\n`
}

/**
 * The one text every Claude Code and Codex session is shown unasked, and for
 * months it carried a single rule. The habits the scorecard found missing
 * (CROFT-294) are each one line here; kept under 300 bytes so the briefing
 * stays a briefing.
 */
const LAB_RULE =
  'Exploring or proving an idea → croft check first; changing a repo for real → a Cairn task (croft push).'

const BRIEFING_RULES = [
  LAB_RULE,
  'Log findings as you go: croft subject note S-n - --kind finding|attempt|decision. Claim the todo you work.',
  'Conclude: croft subject stage S-n "<stage>" --conclusion -. Close todos: done --resolution. Bodies: markdown.',
]

const truncate = (s, n) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One TSV cell from whatever the server sent: a name for an object, no tabs or newlines. */
const cellOf = (v) =>
  v == null || v === false
    ? ''
    : typeof v === 'object'
      ? String(v.name ?? v.ref ?? v.title ?? '')
      : String(v).replace(/[\t\r\n]+/g, ' ')

// ---------------------------------------------------------------------------
// the lab: subjects, stages, tags, and the pairing with Cairn
// ---------------------------------------------------------------------------
const SUBJECT_REF = /^(?:[Ss]-)?(\d{1,7})$/
const SUBJECT_NOTE_KINDS = ['note', 'finding', 'decision', 'attempt', 'handoff']
/** Used only when /stages cannot be read: the seed's concluding stages. */
const SEED_CONCLUDING = new Set(['done', 'rejected', 'rolled out'])
const CONCLUDING = new Set(['completed', 'dropped'])

const subjectArg = (value, usage) => {
  const raw = String(need(value, usage)).trim()
  const match = SUBJECT_REF.exec(raw)
  if (!match) {
    die(
      `"${raw}" is not a subject ref — subjects are S-n (e.g. S-12).` +
        (REF_ARG.test(raw) ? ` ${raw} is a todo: use the task verbs (croft show ${raw}).` : ''),
    )
  }
  return `S-${Number(match[1])}`
}

/**
 * What `croft subject show` would cost, when the server does not say. A
 * summary carries no body, so this is a floor, marked as an estimate by the
 * same `~` every other token column uses.
 */
const subjectTokens = (s) =>
  s.tokens ?? Math.ceil((String(s.title ?? '').length + String(s.body ?? '').length + String(s.conclusion ?? '').length) / 4) + 20

/**
 * Who sees a subject, in one cell: `lab`, `private`, or `members:2` (the
 * people it is shared with, its owner aside). A server older than 0.4 sends
 * no visibility, and everything on it is in the lab.
 */
const visibilityCell = (s) => {
  const v = s.visibility ?? 'lab'
  return v === 'members' ? `members:${(s.members ?? []).length}` : v
}

const SUBJECT_COLUMNS = ['ref', 'stage', 'visibility', 'todos', 'tags', 'project', 'tokens', 'title']
const subjectRow = (s) => ({
  ref: s.ref ?? (s.number !== undefined ? `S-${s.number}` : ''),
  stage: cellOf(s.stage),
  visibility: visibilityCell(s),
  todos: `${s.todos?.open ?? 0}/${s.todos?.done ?? 0}`,
  tags: (s.tags ?? []).map((t) => cellOf(t)).join(','),
  project: cellOf(s.project),
  tokens: `~${subjectTokens(s)}`,
  title: truncate(s.title, 70),
})
/** A list, whether the server sent it bare or under a key. */
const asList = (d, key) => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : Array.isArray(d?.results) ? d.results : [])
const emitSubjects = (list) => emit(list, { rows: (d) => asList(d, 'subjects').map(subjectRow), columns: SUBJECT_COLUMNS })

const todoRow = (t) => ({
  ref: t.ref ?? refOfTask(t) ?? '',
  status: t.status ?? '',
  held: t.claimed_by ?? '',
  cairn: t.cairn_ref ? `${t.cairn_ref}${t.cairn_status ? ` ${t.cairn_status}` : ''}` : '',
  title: truncate(t.title, 70),
})

const FILE_COLUMNS = ['id', 'name', 'kind', 'bytes', 'by', 'url']
const fileRow = (a) => ({
  id: a.id ?? '',
  name: cellOf(a.filename ?? a.original_name),
  kind: a.kind ?? '',
  bytes: a.size_bytes ?? '',
  by: cellOf(a.uploaded_by ?? a.actor_id),
  url: a.content_url ?? '',
})

const DAY = (at) => (typeof at === 'string' ? at.slice(0, 16).replace('T', ' ') : '')

/**
 * A subject as a model reads it: what it is, where it stands, what it
 * concluded, what is left to do, then the write-up and the log. A digest by
 * default — every finding and decision, the last few of everything else, a
 * clipped body — and a line on stderr saying what was withheld.
 */
const renderSubject = (s, notes, todos, { full, humanNotes = [], files = [] }) => {
  const out = [`${s.ref}  ${cellOf(s.stage)}  ${s.title}`]
  const facts = [
    s.owner?.name ? `owner ${s.owner.name}` : 'no owner',
    s.visibility && s.visibility !== 'lab'
      ? s.visibility === 'members'
        ? `shared with ${(s.members ?? []).map((m) => cellOf(m)).join(', ') || 'nobody yet'}`
        : 'private'
      : '',
    s.project?.name ? `project ${s.project.name}${s.project.cairn_key ? ` (Cairn ${s.project.cairn_key})` : ''}` : '',
    s.tags?.length ? `tags ${s.tags.map((t) => cellOf(t)).join(', ')}` : '',
    s.updated_at ? `updated ${DAY(s.updated_at)}` : '',
    s.archived_at ? 'archived' : '',
  ].filter(Boolean)
  out.push(facts.join(' · '))
  if (s.conclusion) out.push('', `conclusion${s.concluded_at ? ` (${DAY(s.concluded_at)})` : ''}:`, ...indent(s.conclusion))

  const open = todos.filter((t) => !['done', 'cancelled'].includes(t.status))
  out.push('', `todos: ${open.length} open / ${todos.length - open.length} closed`)
  for (const t of full ? todos : open) {
    const row = todoRow(t)
    out.push(`  ${row.ref}  ${row.status}${row.held ? `  held by ${row.held}` : ''}  ${row.title}${row.cairn ? `  [Cairn ${row.cairn}]` : ''}`)
  }
  // Counts only: people's notes and files are read on purpose, not in every digest.
  if (humanNotes.length || files.length) {
    out.push(
      '',
      [
        humanNotes.length ? `people's notes: ${humanNotes.length} (croft subject notes ${s.ref})` : '',
        files.length ? `files: ${files.length} (croft subject files ${s.ref})` : '',
      ].filter(Boolean).join(' · '),
    )
  }

  const BODY_CLIP = 1500
  const body = String(s.body ?? '').trim()
  let withheldBody = 0
  if (body) {
    const shown = full || body.length <= BODY_CLIP ? body : `${body.slice(0, BODY_CLIP)}…`
    withheldBody = body.length - Math.min(body.length, full ? body.length : BODY_CLIP)
    out.push('', 'write-up:', ...indent(shown))
  }

  const ordered = [...notes].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  const KEEP = new Set(['finding', 'decision', 'handoff'])
  const recent = new Set(ordered.filter((n) => !KEEP.has(n.kind)).slice(-5))
  const shownNotes = full ? ordered : ordered.filter((n) => KEEP.has(n.kind) || recent.has(n))
  if (ordered.length) {
    out.push('', `log${shownNotes.length < ordered.length ? ` (${shownNotes.length} of ${ordered.length})` : ''}:`)
    for (const n of shownNotes) {
      const text = full ? n.note : truncate(String(n.note).replace(/\s+/g, ' '), 400)
      out.push(`  ${DAY(n.created_at)}  ${n.kind}  ${n.actor_id ?? ''}`, ...indent(text, '    '))
    }
  }
  const withheldNotes = ordered.length - shownNotes.length
  const withheld = withheldBody || withheldNotes
    ? { body: withheldBody, notes: withheldNotes, tokens: Math.ceil((body.length + ordered.reduce((n, x) => n + String(x.note).length, 0)) / 4) }
    : null
  return { text: `${out.join('\n')}\n`, withheld }
}

const indent = (text, pad = '  ') => String(text).trim().split('\n').map((l) => `${pad}${l}`)

/**
 * `--project` on subject add/edit: a lab project's name or id, or `none` to
 * take the subject out of its project (null on the wire). Undefined when the
 * flag was not given.
 */
const labProjectFlag = () => {
  if (flags.project === undefined) return undefined
  const value = String(need(flags.project, '--project needs a lab project name, or none (croft projects lists them)')).trim()
  return value.toLowerCase() === 'none' ? null : value
}

const VISIBILITIES = ['private', 'members', 'lab']

/** `--visibility` on subject add/share: undefined when not given. */
const visibilityFlag = () => {
  if (flags.visibility === undefined) return undefined
  const value = String(need(flags.visibility, `--visibility needs one of ${VISIBILITIES.join(', ')}`)).trim().toLowerCase()
  if (!VISIBILITIES.includes(value)) die(`--visibility must be one of ${VISIBILITIES.join(', ')}`)
  return value
}

/** `+who` adds, `-who` removes; `who` is me, a user id, an email or a name (croft people). */
const memberChanges = (args) => {
  const add = []
  const remove = []
  for (const arg of args.map((a) => String(a).trim()).filter(Boolean)) {
    if (arg.startsWith('-')) remove.push(arg.slice(1).trim())
    else add.push(arg.replace(/^\+/, '').trim())
  }
  return { add: add.filter(Boolean), remove: remove.filter(Boolean) }
}

/**
 * A todo of a subject not yet in the lab stays out of Cairn unless forced:
 * Cairn has no idea who may read it, so filing it there is publishing it.
 */
const unpublishedMessage = (todoRef, subjectRef, visibility) =>
  `${todoRef} belongs to ${subjectRef ?? 'a subject'}, which is ${visibility === 'private' ? 'private' : 'shared with its members only'}: ` +
  `filing it in Cairn shows it to everyone there.\n` +
  `publish the subject first (croft subject publish ${subjectRef ?? 'S-n'}), or re-run with --force to file it anyway`

const unpublishedRefusal = (todoRef) => (payload) => {
  if (payload.code === 'subject_not_published') die(`${todoRef}: ${payload.error}\nre-run with --force to link it anyway`)
}

/** A refusal on a visibility change, said with what to do instead. */
const visibilityRefusal = (ref) => (payload) => {
  if (payload.code === 'already_published') {
    die(`${ref} is already in the lab: publishing is one-way, it cannot be made private or shared again`)
  }
  if (payload.code === 'owner_required') {
    die(`${ref}: only its owner can change who sees it — ${payload.error}`)
  }
}

/**
 * Where `croft push T-41` with no --to files the todo: the Cairn key of its
 * subject's lab project. `{ key }`, or `{ why }` saying what is missing.
 */
const pushTarget = (todo, todoRef) => {
  const subject = todo?.subject
  const key = subject?.project?.cairn_key
  if (key) return { key: String(key).toUpperCase() }
  const why = !subject
    ? `${todoRef} is not part of a subject, so there is no lab project to take a Cairn key from`
    : !subject.project
      ? `${todoRef}'s subject ${subject.ref ?? ''} is in no lab project (croft subject edit ${subject.ref ?? 'S-n'} --project <name>)`
      : `${todoRef}'s lab project ${subject.project.name} has no Cairn key (an administrator sets one in Settings)`
  return { why: `${why}\nsay where it goes: croft push ${todoRef} --to <CAIRN_KEY>` }
}

const tagChanges = (args) => {
  const add = []
  const remove = []
  for (const arg of args.flatMap((a) => String(a).split(',')).map((a) => a.trim()).filter(Boolean)) {
    if (arg.startsWith('-')) remove.push(arg.slice(1).toLowerCase())
    else add.push(arg.replace(/^\+/, '').toLowerCase())
  }
  return { add: add.filter(Boolean), remove: remove.filter(Boolean) }
}

/** Refused, said with what to do: the agent's next call is the fix. */
const conclusionRefusal = (ref, stage) => (payload) => {
  if (payload.code !== 'conclusion_required') return
  die(
    `${ref} -> "${stage}" needs a conclusion: ${payload.error}\n` +
      `re-run with --conclusion "<what the lab concluded, and why>" (or --conclusion - to read markdown from stdin)`,
  )
}

/**
 * Cairn's CLI, found the way Quarry finds its own: an explicit override, then
 * where `cairn setup` installs it, then PATH. null when there is none.
 */
const resolveCairn = () => {
  const override = process.env.CROFT_CAIRN_BIN?.trim()
  if (override) return existsSync(override) ? override : die(`CROFT_CAIRN_BIN=${override} does not exist`)
  const installed = join(HOME, '.local', 'bin', 'cairn')
  if (existsSync(installed)) return installed
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, 'cairn'))) return join(dir, 'cairn')
  }
  return null
}

const NO_CAIRN =
  'croft push needs Cairn\'s CLI, and `cairn` is not in ~/.local/bin or on PATH. ' +
  'Install it (`cairn setup --url <your Cairn>`), or point CROFT_CAIRN_BIN at it.'

const runCairn = (bin, args, input) => {
  // A script path (a checkout, a test double) runs under this node.
  const [cmd, argv] = /\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args]
  return spawnSync(cmd, argv, {
    input: input ?? '',
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * The ref `cairn add` printed. Its TSV is `key<TAB>value` per field; `ref`
 * first, then project.key + number, then a JSON answer, in that order.
 */
const parseCairnRef = (stdout) => {
  const text = String(stdout ?? '')
  const direct = /^ref\t([A-Z][A-Z0-9]{0,9}-\d+)\s*$/m.exec(text)?.[1]
  if (direct) return direct
  const key = /^project\.key\t([A-Z][A-Z0-9]{0,9})\s*$/m.exec(text)?.[1]
  const number = /^number\t(\d+)\s*$/m.exec(text)?.[1]
  if (key && number) return `${key}-${number}`
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.ref === 'string') return parsed.ref
  } catch {
    // not JSON either
  }
  return null
}

/** Croft's todo types are Cairn's; anything unknown files as a feature. */
const CAIRN_TYPES = { feature: 'feature', bug: 'bug', improvement: 'improvement', chore: 'chore', spike: 'spike', docs: 'docs' }

/** Every todo paired with a Cairn task: one listing of T, or subject by subject. */
const linkedTodos = async () => {
  // The list pages at 200, the most the server takes.
  const PAGE = 200
  const tasks = []
  for (let offset = 0; ; offset += PAGE) {
    const listed = await request('GET', `/api/v1/projects/${TODO_KEY}/tasks?limit=${PAGE}&offset=${offset}`, undefined, { soft: true })
    const page = listed?.tasks ?? []
    tasks.push(...page)
    if (page.length < PAGE || (typeof listed?.count === 'number' && tasks.length >= listed.count)) break
  }
  if (tasks.length && tasks.some((t) => 'cairn_ref' in t)) {
    return tasks.filter((t) => t.cairn_ref).map((t) => ({ ...t, ref: refOfTask(t) ?? `${TODO_KEY}-${t.number}` }))
  }
  const subjects = asList(await request('GET', '/api/v1/subjects?archived=include', undefined, { soft: true }), 'subjects')
  const todos = await Promise.all(
    subjects.map((s) => request('GET', `/api/v1/subjects/${s.ref}/todos`, undefined, { soft: true })),
  )
  return todos.flatMap((list) => asList(list, 'todos')).filter((t) => t.cairn_ref)
}

/** The server's code for "no Cairn connection": `croft sync` then goes through this machine's cairn CLI. */
const CAIRN_NOT_CONFIGURED = new Set(['cairn_not_configured'])
/** Done and cancelled, in Croft and in Cairn alike. */
const TERMINAL = new Set(['done', 'cancelled'])

/**
 * The briefing in at most five lines, for a SessionStart hook — Croft's own,
 * or Cairn's when it carries Croft's block. Silent on every failure: a
 * briefing that errors is worse than none, and this runs unasked at the top
 * of every session.
 */
const BRIEF_DEADLINE_MS = Number(process.env.CROFT_BRIEF_DEADLINE_MS ?? 2500)
const renderBrief = (d, stages) => {
  const concluding = Array.isArray(stages)
    ? new Set(stages.filter((s) => CONCLUDING.has(s.category)).map((s) => s.name))
    : SEED_CONCLUDING
  const order = new Map((Array.isArray(stages) ? stages : []).map((s, i) => [s.name, s.position ?? i]))
  const counts = Object.entries(d?.counts ?? {})
    .filter(([name, n]) => Number(n) > 0 && !concluding.has(name))
    .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
  const mine = (d?.mine ?? []).slice(0, 3)
  if (!counts.length && !mine.length) return ''
  const lines = [`Croft — lab: ${counts.length ? counts.map(([name, n]) => `${n} ${name}`).join(' · ') : 'nothing open'}`]
  for (const s of mine) {
    const open = s.todos?.open ?? 0
    lines.push(`  ${s.ref} ${cellOf(s.stage)}  ${truncate(s.title, 60)}${open ? ` — ${open} todo${open === 1 ? '' : 's'}` : ''}`)
  }
  lines.push(LAB_RULE)
  return `${lines.join('\n')}\n`
}

const brief = async () => {
  // --cwd is how a hook says which session this is for; it chose the instance
  // (ROUTE_DIR) and stays on this machine. /subjects/brief narrows nothing by
  // directory, so sending it would only tell a shared instance where this
  // machine keeps its work.
  void flags.cwd
  if (INSTANCE_REFUSAL || IDENTITY_REFUSAL || !KEY || !BASE) return
  const get = async (path) => {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: authHeaders(), signal: AbortSignal.timeout(BRIEF_DEADLINE_MS) })
      const payload = await res.json()
      return payload?.success ? payload.data : null
    } catch {
      return null
    }
  }
  const [data, stages] = await Promise.all([
    get('/api/v1/subjects/brief'),
    get('/api/v1/stages'),
  ])
  if (!data) return
  if (FORMAT === 'json') return emit(data)
  const text = renderBrief(data, stages)
  if (text) process.stdout.write(text)
}


/**
 * A task row as TSV names its assignee in one line, not five: the name is
 * what a reader checks, and the id and email are in --json. Anything without
 * the nested object — the digest's plain name, a claim's raw row — passes.
 */
const named = (task) => {
  if (FORMAT !== 'tsv' || typeof task?.assignee !== 'object' || !task.assignee) return task
  const { assignee_user_id: _id, assignee, ...rest } = task
  return { ...rest, assignee: assignee.name }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const HELP = `croft — the lab board: subjects to explore and prove, their todos and conclusions

  ALWAYS START HERE
    croft check "<subject>"        what the lab already tried, found or concluded
                                   searches subjects, todos and work-log notes;
                                   --kinds subject,task,note; --assignee me|<who>
    Exploring or proving an idea → croft check first; changing a repo for real
    → a Cairn task (croft push).

  subjects (refs S-12)
    croft subject add "<title>" [--stage S] [--tag t]... [--project P] [--owner me] [--body -]
                                   [--visibility lab|members|private] [--member <who>]...
                                   --tag and --member repeat or take a comma list;
                                   default visibility: lab (everyone)
    croft subject list [--stage S] [--tag t] [--project P|none] [--mine] [--all]
                                   --mine: owned by your human; --all: archived too
    croft subject show S-12 [--full]       a digest unless --full
    croft subject edit S-12 [--title T] [--body -] [--project P|none]
    croft subject share S-12 +who -who [--visibility members|private]
                                   who: me, an email or a name (croft people);
                                   sharing a private subject makes it members
    croft subject publish S-12 --confirm S-12
                                   into the lab, for everyone. ONE-WAY: it
                                   cannot be made private again
    croft subject stage S-12 "<stage>" [--conclusion -|"<text>"]
                                   done, rejected, rolled out (any completed or
                                   dropped stage) need a --conclusion
    croft subject note S-12 "<text>"|- [--kind finding|decision|attempt|note|handoff]
    croft subject tag S-12 +x -y           add x, remove y
    croft subject notes S-12       people's notes (the board's Notes tab); write to the log with note
    croft subject attach S-12 <file>  |  croft subject files S-12
                                   images, HTML reports, PDFs…; an image embeds as ![name](url)
    croft subject todo S-12 "<title>" [--body -] [--no-start]
                                   files a todo (T-n) under it; agents claim it
    croft stages                   the pipeline, in order, with each stage's category
    croft tags                     the tags subjects can carry
    croft projects                 the lab projects (Trig, Croft…) a subject can be
                                   part of, each with the Cairn key its todos go to

  todos (refs T-41) — the task verbs
    croft next [--assignee me|<who>]       what to pick up, and why
    croft list [--status S] [--type T] [--label L] [--mine] [--assignee me|<who>]
                                   todos (project T unless --project K)
    croft show T-41 [--full]       a digest unless --full
    croft log T-41 [--kind K]      the work log
    croft claim T-41               exits 9 if another agent holds it
    croft beat T-41                keep a claim alive
    croft checkpoint T-41 --summary "<where things stand>"
    croft release T-41 [--force]   --force only to drop another session's claim
    croft block T-41 --reason "<why>"   |   croft unblock T-41
    croft note T-41 "<text>" [--kind note|finding|decision|attempt|handoff]
    croft update T-41 [--title T] [--status S] [--type T] [--priority P] [--assignee <who>] [--body -]
    croft comment T-41 "<text>"
    croft done T-41 --resolution "<what was actually done>" [--kind fixed|verified|answered|…]
    croft cancel T-41 --resolution "<why it is being dropped>" [--kind wont-fix]
    croft done T-41 --duplicate-of T-31 --resolution "…"
    croft commit T-41 <sha> [--repo PATH] [--branch NAME] [--message TEXT] [--url URL]
    croft run T-41 "<command>" --status passed|failed|skipped [--exit-code N]
                                   record what you already did; nothing is run
    croft attach T-41 <file>  |  croft files T-41  |  croft history T-41
    croft children T-41  |  croft deps T-41  |  croft blockedby T-41 T-40  |  croft unblockedby T-41 T-40
    croft add "<title>" --project K [--type bug] [--priority high] [--body -] [--parent T-40]
                                   a todo with no subject; prefer subject todo
    croft people                   who work can be assigned to

  pairing with Cairn
    croft push T-41 [--to <CAIRN_KEY>] [--type T]
                                   files it in Cairn (cairn add … --label croft:T-41)
                                   and links it; from then on Cairn owns its status.
                                   Without --to: the Cairn key of its subject's project.
                                   A todo of a private or members subject is refused:
                                   publish the subject, or --force to file it anyway
                                   Needs the cairn CLI (PATH, ~/.local/bin or CROFT_CAIRN_BIN)
    croft push T-41 --link CAIRN-331       record a link made by hand
    croft push T-41 <sha> [--repo PATH] [--branch NAME] [--remote NAME] [--url URL]
                                   with a sha: records a git push, as commit does
    croft sync                     pull the status of every paired todo back from Cairn

  briefing
    croft context --brief [--cwd D]        the lab in five lines; silent when there is
                                           nothing to say or nothing is configured
    croft context [--scope project|all] [--project K]
                                   what you hold, what is in flight, stale claims

  labels and task projects
    croft labels  |  croft labels rename <from> <to>  |  croft labels remove <label>
    croft project list [--archived]   the task containers (every todo is in T)
    croft project create <KEY> "<title>" [--body -]   KEY is 1-10 uppercase, starting with a letter
    croft project rename <KEY> "<title>"  |  croft project rekey <KEY> <NEW>
    croft project rename <KEY> --key <NEW>
    croft project archive|restore <KEY>  |  croft project delete <KEY> --confirm <KEY>
    croft task delete <ref> --confirm <ref>       junk only; refuses a task with history
    croft map [<KEY>|none]         which project this directory is

  instances
    croft instance [list]                        which Croft instance a command uses
    croft instance policy ask | default <name>   in a directory with no route
    croft instance add <name> --url <url> [--default] [--adopt]
    croft <command> --instance <name>            use that instance (or CROFT_INSTANCE=<name>)
    croft route                                  which instance this directory uses, and why
    croft route add <instance> [--folder|--session] [--dir D] [--force]
    croft route list | remove [--folder] [--dir D]
    croft --version                              this CLI, the server, and whether they match

  maintenance
    croft reconcile [--older N] [--dry-run]   release your own claims that went quiet (2h);
                                   as CROFT_AGENT=maintenance: every quiet claim
    croft reconcile|sync --all-instances      once per instance on a machine with several
    croft replay                   send writes put aside while the server was down

  connect a machine
    croft setup --url <instance>   pair keys in the browser, install the CLI, skill,
                                   hooks and the agent-files job. Safe to re-run
    croft setup --name <instance>  names the new one on a machine with several
    croft setup --runtimes claude-code,codex,openclaw   default: detected
    croft setup --no-skill | --no-hooks | --no-jobs     skip one step
                                   (the job repairs the CLI, hook and skill to
                                   the installed release's tag; CROFT_REPO=
                                   <owner>/<name> installs and follows a fork)
    croft setup --maintenance      also install reconcile; its key needs an admin
    croft setup --dry-run          print the plan, change nothing

  output
    --json | --pretty              default is TSV: count line, header, rows
    --body -  /  --resolution -  /  --conclusion -   read the value from stdin
    bodies are markdown: ## headings, - lists, code in backticks

  exit codes: 1 error · 2 unknown or ignored flag · 9 already claimed · 10 which instance?
  env: CROFT_BASE_URL, CROFT_API_KEY, CROFT_CAIRN_BIN
`

const need = (v, msg) => (v === undefined || v === true ? die(msg) : v)

const DEAD_END = /\b(tried|no change|didn['’]?t work|did not work|no effect|made no difference|ruled out|dead[- ]end)\b/i

/** Shared by `done` and `cancel`: both close, and both must say how. */
const closeTask = async (status, defaultKind) => {
  const verb = status === 'done' ? 'done' : 'cancel'
  const ref = need(positional[0], `usage: croft ${verb} <ref> --resolution "<why>"`)
  const resolution = await resolveValue(
    need(flags.resolution, 'a --resolution is required: say what was actually done, and why'),
  )
  const body = { status, resolution, resolutionKind: flags.kind ?? defaultKind }
  // Naming the original is what makes "duplicate" useful to whoever finds it.
  if (flags['duplicate-of']) {
    body.duplicateOf = flags['duplicate-of']
    body.resolutionKind = 'duplicate'
  }
  const closed = await request('PATCH', `/api/v1/tasks/${ref}`, body)
  emit(named(closed))
  if (FORMAT !== 'tsv' || status !== 'done') return

  // `fixed` is a claim of authorship, and it was being recorded for audits
  // and answers alike because it is what an omitted --kind means (CROFT-148).
  if (!flags.kind && !body.duplicateOf) {
    process.stderr.write(
      `recorded as fixed — use --kind verified|answered|not-reproducible|superseded if that is not what happened\n`,
    )
  }

  // Said once, at the close, and only when nothing at all showed the work
  // being done: the same predicate the server uses (migration 054), so
  // a sweep item with a commit against it, or one moved to in-review, is not
  // nagged. A person is documented as never claiming, so only a runtime is.
  if (!AGENT) return
  const events = await request('GET', `/api/v1/tasks/${ref}/activity?limit=500`, undefined, { soft: true })
  if (!Array.isArray(events)) return
  const TRACE = new Set(['claimed', 'checkpointed', 'git_commit', 'git_push', 'run_result'])
  const seen = events.some(
    (e) =>
      TRACE.has(e.event) ||
      (e.event === 'status_changed' && !['done', 'cancelled'].includes(e.data?.to ?? '')),
  )
  if (!seen) {
    process.stderr.write(
      `${refOfTask(closed) ?? ref} was closed without ever being claimed — nobody could see it being worked. ` +
        `Next time claim first (\`croft add\` now claims for agents).\n`,
    )
  }
}

/** `from -> to`, or the raw keys, kept to one short cell. */
const summariseEvent = (data) => {
  if (!data || typeof data !== 'object') return ''
  if ('from' in data || 'to' in data) {
    const from = Array.isArray(data.from) ? data.from.join('|') : (data.from ?? '')
    const to = Array.isArray(data.to) ? data.to.join('|') : (data.to ?? '')
    return `${from} -> ${to}`
  }
  return Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

/**
 * The write half of `croft instance add`, factored out so `croft setup` can
 * register an instance without shelling out to itself. Throws a plain Error
 * with a message meant for a person; callers decide how to report it (`die`
 * for the command, setup's own summary lines for the other).
 *
 * `unclassified` is the caller's already-decided policy (from `--default`, or
 * asked at a terminal) — this function never prompts.
 */
const addInstance = async ({ name, url, makeDefault = false, adopt = false, unclassified, pairing = false }) => {
  // Read now, not at startup: `croft setup` adds two in one run (the one it
  // adopts, then the new one), and the second must not overwrite the first.
  const current = readInstances()
  if (current?.error) throw new Error(`croft: ${current.error} — fix it before adding to it`)
  const config = current
    ? { ...current.raw, version: 1, instances: { ...current.instances } }
    : { version: 1, instances: {} }
  const existing = config.instances[name]
  if (existing && trimUrl(existing.url) !== url) {
    throw new Error(`instance "${name}" already points at ${existing.url}; edit ~/.croft/instances.json to change it on purpose`)
  }
  config.instances[name] = { url }
  if (makeDefault) config.unclassified = { mode: 'default', instance: name }
  else if (unclassified) config.unclassified = unclassified

  const dir = instanceDir(name)
  const legacy = ['env', 'projects.json', 'ownership'].filter((f) => existsSync(join(CROFT_DIR, f)))
  const queued = existsSync(CROFT_DIR) && readdirSync(CROFT_DIR).some((f) =>
    (f === 'outbox.jsonl' || f.startsWith(OUTBOX_PREFIX)) &&
    f !== basename(OUTBOX_LOCK_PATH) && f !== basename(OUTBOX_REPLAY_LOCK_PATH))
  const moved = []
  if (adopt && (legacy.length || queued)) {
    // The files at the top of ~/.croft belong to the server they were used
    // with, found the way it always was: the environment, then ~/.croft/env,
    // then localhost. Moving them under a different one would hand one
    // instance's keys, map and queued writes to another.
    const legacyUrl = trimUrl(
      process.env.CROFT_BASE_URL || fileEnv(join(CROFT_DIR, 'env')).CROFT_BASE_URL || 'http://localhost:3000',
    )
    if (legacyUrl !== url) {
      throw new Error(`this machine's existing setup points at ${legacyUrl}, not ${url}: ` +
        '--adopt would move its keys to the wrong instance')
    }
    for (const file of legacy) {
      if (existsSync(join(dir, file))) throw new Error(`~/.croft/instances/${name}/${file} already exists; not overwriting it`)
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (adopt) {
    for (const file of legacy) {
      renameSync(join(CROFT_DIR, file), join(dir, file))
      moved.push(file)
    }
    // Under the queue's own lock, so a write being queued right now lands
    // either before the move or in the next process's instance directory.
    // Appended rather than renamed onto a file already there: an adoption
    // interrupted halfway is finished by running it again, and a rename
    // would replace the queued writes it had already moved.
    await withOutboxLock(() => {
      for (const file of readdirSync(CROFT_DIR)) {
        if (file !== 'outbox.jsonl' && !file.startsWith(OUTBOX_PREFIX)) continue
        if (file === basename(OUTBOX_LOCK_PATH) || file === basename(OUTBOX_REPLAY_LOCK_PATH)) continue
        const from = join(CROFT_DIR, file)
        const to = join(dir, file)
        if (existsSync(to)) {
          appendFileSync(to, readFileSync(from), { mode: 0o600 })
          unlinkSync(from)
        } else renameSync(from, to)
        moved.push(file)
      }
    })
  }
  writeInstancesConfig(config)

  const notes = []
  if (moved.length) notes.push(`moved ${moved.join(', ')} into ~/.croft/instances/${name}/`)
  else if (legacy.includes('env') && !current && !adopt) {
    notes.push('~/.croft/env is no longer read now that instances are configured; ' +
      'its keys belong in the instance they were issued by (or re-run with --adopt)')
  }
  // Setup pairs them next, so the hint is only for `croft instance add`.
  if (!pairing && !existsSync(join(dir, 'env'))) {
    notes.push(`pair this instance's keys with \`croft setup --url ${url}\`, or put them in ` +
      `~/.croft/instances/${name}/env (CROFT_API_KEY_<RUNTIME>=..., mode 600)`)
  }
  if ((config.unclassified?.mode ?? 'ask') === 'ask') {
    notes.push('in a directory with no route, commands stop and ask (exit 10); ' +
      '`croft instance policy default <name>` uses one instead')
  }
  return { config, dir, notes, moved }
}

// ---------------------------------------------------------------------------
// `croft setup` — connect this machine to an instance and install everything.
// ---------------------------------------------------------------------------

/**
 * The name a new instance gets when nobody said `--name`.
 *
 * The hostname's first label is usually generic — `croft`, `app`, the product
 * itself — so those are skipped in favour of the next one, which is usually
 * the thing that actually distinguishes this Croft from another:
 * `croft.app.dispofi.fr` names the instance `dispofi`, not `croft`.
 */
const GENERIC_HOST_LABELS = new Set(['croft', 'app', 'www'])
const deriveInstanceName = (url) => {
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { /* validated by the caller */ }
  const labels = host.split('.').filter(Boolean)
  const picked = labels.find((l) => !GENERIC_HOST_LABELS.has(l)) ?? labels[0] ?? 'instance'
  const cleaned = picked.replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '') || 'instance'
  const safe = cleaned.slice(0, 32)
  return INSTANCE_NAME.test(safe) ? safe : `i-${safe}`.slice(0, 32)
}

/** Filesystem signals for a runtime being on this machine, independent of what process is running this. */
const SETUP_RUNTIME_DIRS = { 'claude-code': join(HOME, '.claude'), codex: join(HOME, '.codex') }
const onSetupPath = (bin) => (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, bin)))
const detectSetupRuntimes = () => {
  const found = []
  if (existsSync(SETUP_RUNTIME_DIRS['claude-code'])) found.push('claude-code')
  if (existsSync(SETUP_RUNTIME_DIRS.codex)) found.push('codex')
  // A gateway, not the binary and not any config: `openclaw` on PATH says it
  // is installed, and a client config (only `gateway.auth`, to reach someone
  // else's gateway) says this account does not run one. Either way the hook is
  // never installed here, and a key minted for it is a live credential with no
  // reader. The same test as `openclawRunsGateway` in scripts/install-hooks.mjs.
  if (openclawRunsGateway()) found.push('openclaw')
  return found
}

const openclawRunsGateway = () => {
  const path = process.env.OPENCLAW_CONFIG_PATH?.trim() || join(HOME, '.openclaw', 'openclaw.json')
  if (!existsSync(path)) return false
  let config
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return true // JSON5 this cannot parse: the benefit of the doubt, as the hook installer gives it
  }
  const gateway = config?.gateway ?? {}
  return Boolean(gateway.mode || gateway.port || config?.agents || config?.channels)
}

/** Rewrite or append `KEY=value` lines in an env file, leaving everything else untouched. */
const setEnvKeys = (path, updates) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  const written = new Set()
  const rewritten = lines.map((line) => {
    const trimmed = line.trim()
    const eq = trimmed.indexOf('=')
    if (!trimmed || trimmed.startsWith('#') || eq === -1) return line
    const key = trimmed.slice(0, eq).trim()
    if (!(key in updates)) return line
    written.add(key)
    return `${key}=${updates[key]}`
  })
  while (rewritten.length && rewritten[rewritten.length - 1].trim() === '') rewritten.pop()
  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) rewritten.push(`${key}=${value}`)
  }
  writeFileSync(path, `${rewritten.join('\n')}\n`, { mode: 0o600 })
  // `mode` only applies when a file is created: an env file that already
  // existed with looser permissions would keep them, keys and all.
  chmodSync(path, 0o600)
  chmodSync(dirname(path), 0o700)
}

const sameWebOrigin = (candidate, baseUrl) => {
  try {
    const url = new URL(candidate)
    return ['http:', 'https:'].includes(url.protocol) && url.origin === new URL(baseUrl).origin
  } catch {
    return false
  }
}

/** `open` on macOS, `xdg-open` on Linux. Best effort: a failure never blocks pairing. */
const openBrowser = (url) => {
  try {
    spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', timeout: 3000 })
  } catch { /* the link is printed either way */ }
}

/**
 * The pairing flow against SERVER CONTRACT in CROFT-314: connect, print the
 * link, poll until a person approves it (or denies, or lets it expire), and
 * hand back the keys it issued. A server predating pairing answers 404 on
 * `/connect`, which is not a failure — it is a machine setup still has to
 * finish by other means, so the caller decides what to do with `fallback`.
 */
const pairDevice = async ({ baseUrl, runtimes, write }) => {
  let connectRes
  try {
    connectRes = await fetch(`${baseUrl}/api/v1/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The server takes a hostname's characters and no others: it goes on the
      // approval card and into every key's name.
      body: JSON.stringify({
        // CROFT_HOST names it when set; with CROFT_SHARE_LOCATION=off the real
        // hostname stays on this machine here too.
        host: (HOST ?? (SHARE_LOCATION ? hostname() : 'private-host')).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100) || 'unknown-host',
        runtimes,
        cliVersion: VERSION,
      }),
    })
  } catch (error) {
    throw new Error(`cannot reach ${baseUrl}: ${error.message}`)
  }
  if (connectRes.status === 404) return { fallback: true }
  const body = await connectRes.json().catch(() => null)
  if (!connectRes.ok || !body?.success) {
    throw new Error(`${baseUrl}/api/v1/connect failed (${connectRes.status})`)
  }
  const { deviceCode, userCode, verificationUrl, expiresIn = 600, interval = 5 } = body.data ?? {}
  write(`Open this link to connect this machine:\n  ${verificationUrl}${userCode ? ` (code ${userCode})` : ''}\n`)
  // Best effort, and only where there is plausibly someone at a screen to
  // hand a tab to — a scheduled or piped run gets the printed link instead.
  // Only a web page on the instance itself: `open` runs whatever it is given,
  // and a server (or anyone between it and an http:// --url) chooses this.
  if (process.stderr.isTTY && sameWebOrigin(verificationUrl, baseUrl)) openBrowser(verificationUrl)
  write('waiting for approval… ')
  const deadline = Date.now() + expiresIn * 1000
  let wait = interval
  for (;;) {
    if (Date.now() > deadline) { write('expired\n'); return { expired: true } }
    await sleep(wait * 1000)
    let pollRes
    try {
      pollRes = await fetch(`${baseUrl}/api/v1/connect/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      })
    } catch {
      continue // a blip mid-poll is not the answer; keep waiting out the window
    }
    const poll = (await pollRes.json().catch(() => null))?.data
    if (!poll) continue
    if (poll.status === 'approved') {
      write(`✓ approved by ${poll.user?.name || poll.user?.email || 'someone'}\n`)
      return { keys: poll.keys ?? [], user: poll.user }
    }
    if (poll.status === 'denied') { write('denied\n'); return { denied: true } }
    if (poll.status === 'expired') { write('expired\n'); return { expired: true } }
    if (poll.slowDown) wait += 2
  }
}

/** A cheap authenticated call, to tell a stale or revoked key from a good one before re-pairing over it. */
const keyIsValid = async (baseUrl, key) => {
  try {
    const res = await fetch(`${baseUrl}/api/v1/people`, { headers: { Authorization: `Bearer ${key}` } })
    return res.ok
  } catch {
    return false
  }
}

/**
 * The task containers, as `croft projects` listed them before lab projects:
 * `croft project list [--archived]`. Every todo lives in `T`.
 */
const listTaskProjects = async () => {
  const suffix = flags.archived ? '?archived=1' : ''
  const data = await request('GET', `/api/v1/projects${suffix}`)
  if (FORMAT !== 'tsv') return emit(data)
  // `was` is the keys a project used to have, space-separated, and it is the
  // LAST column: readers of this table (trig's connector among them) key on
  // the header, and a column appended at the end is one they never see move.
  // When they were retired, and by whom, is in --json as `former_keys`.
  const rows = data.map(({ former_keys: former, ...rest }) => ({
    ...rest,
    was: (former ?? []).map((f) => f.key).join(' '),
  }))
  const columns = [
    ...new Set(rows.flatMap(({ was: _was, ...rest }) => Object.keys(flatten(rest)))),
    'was',
  ]
  emit(rows, { columns })
}

const commands = {
  async check() {
    const q = need(positional[0], 'usage: croft check "<subject>"')
    const params = new URLSearchParams({ q })
    if (flags.project) params.set('project', flags.project)
    if (flags.type) params.set('type', flags.type)
    if (flags.kinds) params.set('kinds', flags.kinds)
    if (flags.tasks) params.set('tasksOnly', '1')
    // Whose tasks. Like --type, a statement about tasks, so the answer is
    // tasks only.
    if (flags.assignee) params.set('assignee', flags.assignee)
    const data = await request('GET', `/api/v1/search?${params}`)
    // The exact-ref hit, when the ref asked for used a retired key: said before
    // the table, so "AC-113" coming back as HOL-113 is not a mystery.
    for (const r of data.results ?? []) {
      if (r.renamedFrom) tellRename(r.requestedRef, r.renamedFrom, r.ref)
    }
    emit(data, {
      rows: (d) =>
        d.results.map((r) => ({
          // Whatever kind the server sends is printed as it is: a subject
          // carries its stage where a task carries its status.
          kind: r.kind ?? 'task',
          ref: r.ref ?? r.slug ?? r.id ?? '',
          status: cellOf(r.stage) || cellOf(r.status),
          type: cellOf(r.type),
          answered: r.resolved || r.conclusion ? 'yes' : '',
          tokens: r.tokens == null ? '' : `~${r.tokens}`,
          title: truncate(cellOf(r.title) || cellOf(r.snippet), 70),
        })),
      columns: ['kind', 'ref', 'status', 'type', 'answered', 'tokens', 'title'],
    })
    if (FORMAT !== 'tsv') return

    if (data.results.length === 0) {
      process.stderr.write('nothing found — this subject looks new\n')
      return
    }

    // Widening only happens when the precise query came back thin, so a result
    // set that is entirely loose means nothing actually matched the subject.
    // Without saying so, twenty plausible-looking rows read as prior work.
    const loose = data.results.filter((r) => r.loose).length
    if (loose === data.results.length) {
      process.stderr.write(
        `no precise match — all ${loose} rows are loose word overlaps, so treat this subject as new unless one genuinely fits\n`,
      )
    } else if (loose > 0) {
      process.stderr.write(`${data.results.length - loose} precise, ${loose} loose\n`)
    }
  },

  async list() {
    // Todos, unless told otherwise: every subject's todos live in project T.
    const project = flags.project ?? positional[0] ?? TODO_KEY
    const params = new URLSearchParams()
    for (const k of ['status', 'type', 'label', 'limit', 'offset']) {
      if (flags[k]) params.set(k, flags[k])
    }
    // The server resolves who "mine" is. This used to send
    // `claimed_by=$CROFT_AGENT`, which guessed the caller from an environment
    // variable and, when it was unset, asked for tasks held by the empty
    // string -- an answer that looked like an answer.
    if (flags.mine) params.set('mine', 'true')
    // Whose, not who is on it: `me` is the human behind this key, resolved by
    // the server of whichever instance answers.
    if (flags.assignee) params.set('assignee', flags.assignee)
    const data = await request('GET', `/api/v1/projects/${project}/tasks?${params}`)
    emit(data, {
      rows: (d) =>
        d.tasks.map((t) => ({
          ref: `${t.project?.key ?? project}-${t.number}`,
          status: t.status,
          type: t.type,
          priority: t.priority,
          assignee: t.assignee?.name ?? '',
          held: t.claimed_by ?? '',
          answered: t.resolution ? 'yes' : '',
          title: truncate(t.title, 70),
        })),
      columns: ['ref', 'status', 'type', 'priority', 'assignee', 'held', 'answered', 'title'],
    })
  },

  async show() {
    const ref = need(positional[0], 'usage: croft show <ref>')
    // A digest by default: the answer in full, findings and decisions, a
    // clipped body, and a note of what was withheld. `--full` for everything.
    const suffix = flags.full ? '' : '?view=digest'
    const data = await request('GET', `/api/v1/tasks/${ref}${suffix}`)
    emit(named(data))
    if (FORMAT === 'tsv' && data.omitted) {
      const { descriptionBytes, attemptsAndNotes, tokensToFetchFull } = data.omitted
      if (descriptionBytes || attemptsAndNotes) {
        process.stderr.write(
          `withheld: ${descriptionBytes}B of body, ${attemptsAndNotes} attempt/note(s)` +
            ` — croft show ${ref} --full is ~${tokensToFetchFull} tokens\n`,
        )
      }
    }
  },

  /**
   * The lab projects (Trig, Croft…): what a subject can be part of, and the
   * Cairn project each one's todos go to on `croft push T-n`. The task
   * containers this used to list are an internal detail now — every todo
   * lives in `T` — and are still listed by `croft project list`.
   */
  async projects() {
    const data = await request('GET', '/api/v1/lab-projects')
    emit(data, {
      rows: (d) =>
        [...asList(d, 'projects')]
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map((p) => ({ project: cellOf(p.name), cairn: p.cairn_key ?? '', subjects: p.subjects ?? '' })),
      columns: ['project', 'cairn', 'subjects'],
    })
  },

  async people() {
    const data = await request('GET', '/api/v1/people')
    emit(data, { rows: (d) => d.map(({ name, email }) => ({ name, email })), columns: ['name', 'email'] })
  },

  async add() {
    const title = need(positional[0], 'usage: croft add "<title>" --project <KEY>')
    const project = need(flags.project, 'a --project is required')

    /**
     * A bug or a spike with no body is not yet a report — it is a title.
     *
     * Measured before this existed: 23% of tasks filed in a month had an empty
     * description, and it split by author rather than by subject — 51% for one
     * agent, 75% for another, 0% for tasks filed by a human through the UI. The
     * same agents write a resolution on every single close, because `done`
     * refuses without one. Guidance alone had not moved it; a refusal had.
     *
     * Only where the body carries the value. A chore is often fully described
     * by its title, and demanding prose there teaches people to type "n/a",
     * which is worse than an empty field because it looks answered.
     */
    // Resolved once, here: `--body -` reads stdin, which cannot be read twice,
    // and both the check below and the request itself need the value.
    const described = flags.body ? String(await resolveValue(flags.body)) : undefined

    const NEEDS_BODY = new Set(['bug', 'spike'])
    if (NEEDS_BODY.has(flags.type) && !flags['force-empty']) {
      if ((described ?? '').trim().length < 40) {
        die(
          `a ${flags.type} needs a body: what happens, what you expected, and how to see it.\n` +
            '  croft add "<title>" --project K --type ' + flags.type + ' --body -   # markdown on stdin\n' +
            '  ...--body "one line is fine when that is genuinely all there is"\n' +
            'If the title really is the whole story, pass --force-empty.',
        )
      }
    }

    // Warn on a near-duplicate rather than silently filing one.
    //
    // websearch_to_tsquery ANDs its terms, so passing the whole title finds
    // nothing unless a prior task shares every word. For a similarity check we
    // want the opposite, so OR the distinctive words together instead.
    const terms = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
      .slice(0, 6)
    const probe = terms.length ? terms.join(' OR ') : title

    /**
     * An agent that files a task is, most of the time, about to do it.
     *
     * `--start` existed and was used on 37% of Claude Code's adds against 86%
     * for Codex, and 35% of Claude Code's closes had never been claimed
     * (CROFT-294). A flag the caller has to remember is the discipline that
     * already failed, so for a runtime the default flips; a person filing
     * from a terminal is unchanged, as claim.ts already treats them.
     *
     * Not when this session already holds work in the project: that is a
     * follow-up filed mid-task, and claiming it too puts a second task in
     * `doing` that nobody is doing. Not when --status says where the task
     * goes. Not when similar open work exists — below.
     */
    const optedOut = Boolean(flags['no-start'])
    const autoStart = !flags.start && !optedOut && !flags.status && Boolean(AGENT)
    // Tasks only. "Has this already been filed" is a question about tasks, and
    // answering it with a session from three weeks ago is noise in front of the
    // one thing the agent is about to decide.
    const [dupes, mine] = await Promise.all([
      request('GET', `/api/v1/search?${new URLSearchParams({ q: probe, kinds: 'task' })}`),
      autoStart
        ? request('GET', `/api/v1/projects/${project}/tasks?mine=true&limit=5`, undefined, { soft: true })
        : null,
    ])
    if (dupes.results.length > 0) {
      process.stderr.write('similar existing work:\n')
      for (const r of dupes.results.slice(0, 3)) {
        process.stderr.write(`  ${r.ref} [${r.status}] ${r.title}\n`)
      }
    }
    // The probe ORs the title's words, so nearly every add finds *something*.
    // Holding the claim back on any hit would hold it back on every add; only
    // an open task sharing most of the title's distinctive words counts.
    const OPEN = new Set(['backlog', 'todo', 'doing', 'in-review'])
    const wordsOf = (s) => new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))
    const mineWords = wordsOf(title)
    const sameWork = (other) => {
      const theirs = wordsOf(other)
      const shared = [...mineWords].filter((w) => theirs.has(w)).length
      return shared >= Math.max(2, Math.ceil(Math.min(mineWords.size, theirs.size) / 2))
    }
    const similarOpen = dupes.results
      .slice(0, 3)
      .find((r) => OPEN.has(r.status) && sameWork(r.title))
    const holding = (mine?.tasks ?? []).find((t) => t.claimed_by && OPEN.has(t.status))

    const body = { title }
    if (described !== undefined) body.description = described
    // The server holds the same rule now (CROFT-291), so the escape hatch has
    // to travel with the request. An older server strips the unknown key.
    if (flags['force-empty']) body.forceEmpty = true

    for (const k of ['type', 'status', 'priority']) if (flags[k]) body[k] = flags[k]
    if (flags.label) body.labels = String(flags.label).split(',')
    if (flags.parent) body.parentRef = flags.parent
    // Omitted, the server assigns it to the human behind this key.
    if (flags.assignee) body.assignee = flags.assignee
    const created = named(await request('POST', `/api/v1/projects/${project}/tasks`, body))

    // File-and-work-it-now is the pattern that skips claiming: the agent that
    // files a task and finishes it in the same session never perceives a
    // difference, so the board shows backlog while the work happens.
    if (flags.start) {
      const held = await request('POST', `/api/v1/tasks/${created.ref}/claim`, {})
      return emit({ ...created, status: held.status, claimed_by: held.claimed_by })
    }
    if (autoStart) {
      // Filed either way. Claiming on top of a possible duplicate would put two
      // tasks for one piece of work in `doing`, which is worse than neither.
      if (similarOpen) {
        process.stderr.write(
          `NOT CLAIMED: ${similarOpen.ref} [${similarOpen.status}] looks like the same work. ` +
            `Work that one, or \`croft claim ${created.ref}\` if this really is new.\n`,
        )
      } else if (holding) {
        process.stderr.write(
          `not claimed: you already hold ${holding.project?.key ?? project}-${holding.number} here — ` +
            `\`croft claim ${created.ref}\` if you are switching to this now\n`,
        )
      } else {
        // Soft: the task exists now, and a refused claim must not read as a
        // failed add that the caller then retries into a duplicate.
        const held = await request('POST', `/api/v1/tasks/${created.ref}/claim`, {}, { soft: true })
        if (held) {
          process.stderr.write(`claimed ${created.ref} (agents' adds start the work; --no-start to only file it)\n`)
          return emit({ ...created, status: held.status, claimed_by: held.claimed_by })
        }
        process.stderr.write(`filed ${created.ref} but could not claim it — \`croft claim ${created.ref}\`\n`)
      }
    }
    emit(created)
  },

  async update() {
    const ref = need(positional[0], 'usage: croft update <ref> --status <s>')
    const body = {}
    if (flags.title) body.title = flags.title
    if (flags.body) body.description = await resolveValue(flags.body)
    for (const k of ['type', 'status', 'priority']) if (flags[k]) body[k] = flags[k]
    if (flags.label) body.labels = String(flags.label).split(',')
    // Passed through so a single update can move to a closing status and say
    // how in one call — without it the API rightly refuses the move.
    if (flags.resolution) body.resolution = await resolveValue(flags.resolution)
    if (flags.kind) body.resolutionKind = flags.kind
    if (flags.parent) body.parentRef = flags.parent
    if (flags['no-parent']) body.parentRef = null
    if (flags.assignee) body.assignee = flags.assignee
    // Moving renumbers the task, so the response reports the new ref.
    if (flags.project) body.project = flags.project
    // Widening does not: the task keeps its home project and its ref, and only
    // starts appearing in the other projects' lists and boards too.
    if (flags['also-project'] !== undefined) body.alsoProjects = splitList(flags['also-project'])
    if (flags['duplicate-of']) {
      body.duplicateOf = flags['duplicate-of']
      body.resolutionKind = 'duplicate'
    }
    emit(named(await request('PATCH', `/api/v1/tasks/${ref}`, body)))
  },

  async done() {
    return closeTask('done', 'fixed')
  },

  /**
   * Cancelling is closing too. Without this the CLI could reach five of the
   * six statuses, and a task dropped on purpose had to be edited by hand.
   */
  async cancel() {
    return closeTask('cancelled', 'wont-fix')
  },

  async commit() {
    const ref = need(positional[0], 'usage: croft commit <ref> <sha> [--repo PATH]')
    const sha = need(positional[1], 'a commit SHA is required')
    const payload = { event: 'git_commit', sha }
    if (flags.repo) payload.repo = flags.repo
    if (flags.branch) payload.branch = flags.branch
    if (flags.message) payload.message = await resolveValue(flags.message)
    if (flags.url) payload.url = flags.url
    return emit(await request('POST', `/api/v1/tasks/${ref}/activity`, payload))
  },

  async run() {
    const ref = need(positional[0], 'usage: croft run <ref> "<command>" --status passed|failed|skipped')
    const command = await resolveValue(need(positional[1], 'the command is required'))
    const status = need(flags.status, '--status is required')
    if (!['passed', 'failed', 'skipped'].includes(status)) {
      die('--status must be passed, failed, or skipped')
    }
    const payload = { event: 'run_result', command, status }
    for (const [flag, field] of [['exit-code', 'exitCode'], ['duration-ms', 'durationMs']]) {
      if (flags[flag] !== undefined) payload[field] = Number(flags[flag])
    }
    if (flags.output !== undefined) payload.output = await resolveValue(flags.output)
    if (flags.url) payload.url = flags.url
    return emit(await request('POST', `/api/v1/tasks/${ref}/activity`, payload))
  },

  async note() {
    const ref = need(positional[0], 'usage: croft note <ref> "<text>"')
    const note = await resolveValue(need(positional[1], 'a note body is required'))
    const result = await request('POST', `/api/v1/tasks/${ref}/notes`, {
      note,
      kind: flags.kind ?? 'note',
    })
    emit(result)

    // A hint, not a reclassification: the words are a guess, and only the
    // writer knows. 19 of 1,469 Claude Code notes were `attempt` (CROFT-294),
    // while "tried X, no change" is exactly what the next agent needs flagged.
    if (!flags.kind && FORMAT === 'tsv' && DEAD_END.test(note)) {
      process.stderr.write(
        `reads like a dead end — \`croft note ${ref} "…" --kind attempt\` marks it so the next agent does not retry it\n`,
      )
    }

    // Said, not inferred. Writing a note used to claim the task, which put
    // work in `doing` that nobody was doing — annotating is most of what
    // reading a backlog is. Pointing at the claim leaves the judgement with
    // the only party that knows which of the two this was.
    if (result?.unclaimed && FORMAT === 'tsv') {
      process.stderr.write(
        `${ref} is open and unclaimed — \`croft claim ${ref}\` if you are working it\n`,
      )
    }
  },

  async log() {
    const ref = need(positional[0], 'usage: croft log <ref>')
    const suffix = flags.kind ? `?kind=${flags.kind}` : ''
    const data = await request('GET', `/api/v1/tasks/${ref}/notes${suffix}`)
    emit(data, {
      rows: (d) =>
        d.map((n) => ({
          kind: n.kind,
          by: n.actor_id,
          at: n.created_at.slice(0, 16).replace('T', ' '),
          note: truncate(n.note, 90),
        })),
      columns: ['kind', 'by', 'at', 'note'],
    })
  },

  async comment() {
    const ref = need(positional[0], 'usage: croft comment <ref> "<text>"')
    const content = await resolveValue(need(positional[1], 'a comment body is required'))
    emit(await request('POST', `/api/v1/tasks/${ref}/comments`, { content }))
  },

  async attach() {
    const ref = need(positional[0], 'usage: croft attach <ref> <file>')
    const file = need(positional[1], 'a file path is required')
    const size = statSync(file).size
    process.stderr.write(`uploading ${basename(file)} (${size} bytes, ${mimeOf(file)})\n`)
    emit(await upload(`/api/v1/tasks/${ref}/attachments`, file))
  },

  async files() {
    const ref = need(positional[0], 'usage: croft files <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/attachments`)
    emit(data, {
      rows: (d) =>
        d.map((a) => ({
          id: a.id,
          name: a.original_name,
          type: a.mime_type,
          bytes: a.size_bytes,
          by: a.actor_id,
        })),
      columns: ['id', 'name', 'type', 'bytes', 'by'],
    })
  },

  async children() {
    const ref = need(positional[0], 'usage: croft children <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/children`)
    emit(data.children, {
      rows: (d) => d.map((t) => ({ ref: t.ref, status: t.status, title: truncate(t.title, 62) })),
      columns: ['ref', 'status', 'title'],
    })
    if (FORMAT === 'tsv') {
      process.stderr.write(
        data.count === 0 ? 'no sub-tasks\n' : `${data.closed}/${data.count} closed\n`,
      )
    }
  },

  async history() {
    const ref = need(positional[0], 'usage: croft history <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/activity`)
    emit(data, {
      rows: (d) =>
        d.map((e) => ({
          when: e.created_at.slice(0, 16).replace('T', ' '),
          who: e.actor_id,
          event: e.event,
          detail: summariseEvent(e.data),
        })),
      columns: ['when', 'who', 'event', 'detail'],
    })
    if (FORMAT === 'tsv' && data.length === 0) process.stderr.write('no recorded activity\n')
  },

  async deps() {
    const ref = need(positional[0], 'usage: croft deps <ref>')
    const data = await request('GET', `/api/v1/tasks/${ref}/dependencies`)
    emit(data, {
      rows: (d) =>
        d.map((r) => ({
          direction: r.direction,
          ref: r.ref,
          status: r.status,
          title: truncate(r.title, 62),
        })),
      columns: ['direction', 'ref', 'status', 'title'],
    })
    if (FORMAT === 'tsv' && data.length === 0) {
      process.stderr.write('no dependencies\n')
    }
  },

  async blockedby() {
    const ref = need(positional[0], 'usage: croft blockedby <ref> <other-ref>')
    const other = need(positional[1], 'the blocking task ref is required')
    emit(await request('POST', `/api/v1/tasks/${ref}/dependencies`, {
      ref: other,
      direction: 'blocked-by',
    }))
  },

  async unblockedby() {
    const ref = need(positional[0], 'usage: croft unblockedby <ref> <other-ref>')
    const other = need(positional[1], 'the blocking task ref is required')
    const q = new URLSearchParams({ ref: other, direction: 'blocked-by' })
    emit(await request('DELETE', `/api/v1/tasks/${ref}/dependencies?${q}`))
  },

  async labels() {
    const sub = positional[0]
    if (sub === 'rename' || sub === 'merge') {
      const from = need(positional[1], 'usage: croft labels rename <from> <to>')
      const to = need(positional[2], 'a new label name is required')
      emit(await request('PATCH', '/api/v1/labels', { from, to }))
      return
    }
    if (sub === 'remove' || sub === 'delete') {
      const from = need(positional[1], 'usage: croft labels remove <label>')
      emit(await request('PATCH', '/api/v1/labels', { from, to: null }))
      return
    }
    if (sub) die(`unknown subcommand "${sub}" — expected rename or remove`)

    const data = await request('GET', '/api/v1/labels')
    emit(data, {
      rows: (d) => d.map((l) => ({ label: l.label, tasks: l.task_count })),
      columns: ['label', 'tasks'],
    })
  },

  /**
   * Deleting a task, which almost nobody should be doing.
   *
   * `cancel` keeps the record and the reason and is what this store is for;
   * this is for junk that should never have existed. The server refuses a task
   * with children, notes, comments or dependants, and demands the ref back.
   */
  async task() {
    const sub = need(positional[0], 'usage: croft task delete <ref> --confirm <ref>')
    if (sub !== 'delete') die(`unknown subcommand "${sub}" — expected delete`)
    const ref = need(positional[1], 'a task ref is required, e.g. CAI-42')

    // Ask before telling: the ref the server knows is canonical (a former
    // project key still resolves), and confirming with a spelling the server
    // will not echo back would fail for a reason nobody could see.
    const task = await request('GET', `/api/v1/tasks/${encodeURIComponent(ref)}`)
    const canonical = `${task.project.key}-${task.number}`

    if (flags.confirm !== canonical) {
      die(
        `This permanently deletes ${canonical} — "${task.title}" — and cannot be undone.\n` +
          `Cancelling keeps the record: croft cancel ${canonical} --resolution "..."\n` +
          `Re-run with --confirm ${canonical} if deletion is really what you want.`,
      )
    }

    emit(
      await request(
        'DELETE',
        `/api/v1/tasks/${encodeURIComponent(canonical)}?confirm=${encodeURIComponent(canonical)}`,
      ),
    )
  },

  async project() {
    const sub = need(
      positional[0],
      'usage: croft project <list|create|rename|rekey|archive|restore|delete> <KEY> [...]',
    )
    // The task containers (T holds every todo). Lab projects are `croft projects`.
    if (sub === 'list') return listTaskProjects()
    const key = need(positional[1], 'a project key is required')

    /**
     * Creating one, which this CLI could not do until now.
     *
     * The server has always accepted POST /api/v1/projects, so any agent that
     * went looking at the OpenAPI document could open a project while an agent
     * following the CLI concluded it was not allowed to. Two agents reading
     * the same system got different answers about what they may do, and that
     * asymmetry is what this closes — the capability was already there.
     */
    if (sub === 'create') {
      const title = need(positional[2], 'usage: croft project create <KEY> "<title>"')
      // Checked here as well as on the server, so the error names the rule
      // rather than coming back as a validation failure from a POST.
      if (!/^[A-Z][A-Z0-9]{0,9}$/.test(key)) {
        die(`"${key}" is not a project key — 1 to 10 uppercase letters or digits, starting with a letter, e.g. LAB`)
      }
      const description = flags.body === undefined ? undefined : await resolveValue(flags.body)
      emit(
        await request('POST', '/api/v1/projects', {
          key,
          title,
          ...(description ? { description } : {}),
        }),
      )
      return
    }

    /**
     * Changing the KEY, which the API has always allowed and this CLI never
     * offered — so the one rename that rewrites every ref was the one only
     * reachable by a hand-written PATCH (CROFT-264). `rekey` says what it does;
     * `rename --key` is the same thing in the spelling `entities rename` uses.
     */
    const rekey = async (newKey, title) => {
      if (!/^[A-Z][A-Z0-9]{0,9}$/.test(newKey)) {
        die(`"${newKey}" is not a project key — 1 to 10 uppercase letters or digits, starting with a letter, e.g. LAB`)
      }
      const data = await request('PATCH', `/api/v1/projects/${key}`, {
        key: newKey,
        ...(title ? { title } : {}),
      })
      emit(data)
      if (FORMAT !== 'tsv') return
      if (!data.former_key) {
        process.stderr.write(`${data.key} already has that key; nothing changed.\n`)
        return
      }
      const was = data.former_key
      process.stderr.write(
        `renamed ${was} -> ${data.key}: every ${was}-n ref now reads ${data.key}-n.\n` +
          `${was}-n refs keep resolving, so commits and notes that say ${was}-42 still find ` +
          `${data.key}-42, and ${was} cannot be given to another project.\n` +
          `checkouts mapped to ${was} keep working; run "croft map ${data.key}" in each to update the map.\n`,
      )
    }

    if (sub === 'rekey') {
      await rekey(need(positional[2], 'usage: croft project rekey <KEY> <NEW_KEY>'))
      return
    }

    if (sub === 'rename') {
      if (flags.key !== undefined) {
        const newKey = need(flags.key, 'usage: croft project rename <KEY> --key <NEW_KEY> ["<new title>"]')
        await rekey(newKey, positional[2])
        return
      }
      const title = need(positional[2], 'usage: croft project rename <KEY> "<new title>"  (or --key <NEW_KEY>)')
      emit(await request('PATCH', `/api/v1/projects/${key}`, { title }))
      return
    }
    if (sub === 'archive' || sub === 'restore') {
      emit(await request('PATCH', `/api/v1/projects/${key}`, {
        status: sub === 'archive' ? 'archived' : 'active',
      }))
      return
    }
    if (sub === 'delete') {
      // Deleting a project removes every task in it. The API demands the key
      // back as confirmation; require it here too rather than passing it
      // silently on the caller's behalf.
      if (flags.confirm !== key) {
        const info = await request('GET', `/api/v1/projects/${key}`)
        die(
          `This would delete ${info.task_count} task(s) in ${key} and everything ` +
            `attached to them, permanently.\nRe-run with --confirm ${key} if that is what you want.`,
        )
      }
      emit(await request('DELETE', `/api/v1/projects/${key}?confirm=${encodeURIComponent(key)}`))
      return
    }
    die(`unknown subcommand "${sub}" — expected create, rename, rekey, archive, restore or delete`)
  },

  async claim() {
    const ref = need(positional[0], 'usage: croft claim <ref>')
    emit(named(await request('POST', `/api/v1/tasks/${ref}/claim`, {})))
  },
  async beat() {
    emit(named(await request('POST', `/api/v1/tasks/${need(positional[0], 'usage: croft beat <ref>')}/beat`, {})))
  },
  /**
   * `--force` releases a claim another session holds. The server refuses that
   * by default, because releasing somebody else's claim used to be silent and
   * indistinguishable from releasing your own.
   */
  async release() {
    const ref = need(positional[0], 'usage: croft release <ref> [--force]')
    emit(named(await request('POST', `/api/v1/tasks/${ref}/release`, { force: Boolean(flags.force) })))
  },
  async checkpoint() {
    const ref = need(positional[0], 'usage: croft checkpoint <ref> --summary "<state>"')
    const summary = await resolveValue(need(flags.summary, 'a --summary is required'))
    emit(named(await request('POST', `/api/v1/tasks/${ref}/checkpoint`, { summary })))
  },
  async block() {
    const ref = need(positional[0], 'usage: croft block <ref> --reason "<why>"')
    const reason = await resolveValue(need(flags.reason, 'a --reason is required'))
    emit(named(await request('POST', `/api/v1/tasks/${ref}/block`, { reason })))
  },
  async unblock() {
    const ref = need(positional[0], 'usage: croft unblock <ref>')
    emit(named(await request('POST', `/api/v1/tasks/${ref}/block`, { reason: null })))
  },

  /**
   * Send whatever was put aside while the server was unreachable.
   *
   * Rarely needed by hand — any successful write drains the queue — but a
   * queue with no way to look at it is a queue nobody trusts.
   */
  async replay() {
    const result = await flushOutbox()
    emit(result, {
      lines: (d) =>
        d.sent + d.rejected + d.left === 0
          ? ['nothing queued']
          : [
              `sent ${d.sent}, rejected ${d.rejected}, still queued ${d.left}` +
                (d.waiting ? ` (${d.waiting} for another runtime or instance)` : ''),
            ],
    })
  },

  /**
   * What to pick up, rather than what exists.
   *
   * The briefing says what is held, in flight and dropped, and never which one
   * to do — so every agent invented its own ranking and they disagreed. The
   * reason is printed with the pick because a recommendation nobody can check
   * is one nobody should follow.
   */
  async next() {
    const params = new URLSearchParams()
    const project = flags.project ?? projectForDir(process.cwd())
    if (project) params.set('project', project)
    if (flags.assignee) params.set('assignee', flags.assignee)
    const data = await request('GET', `/api/v1/next?${params}`)

    if (FORMAT === 'json') return emit(data)
    if (!data.pick) {
      const why = data.considered
        ? `nothing workable — ${data.considered} open, all blocked, waiting on something, or held by someone else`
        : 'nothing open'
      process.stdout.write(`${why}\n`)
      return
    }

    // The assignee rides on every line: an agent choosing from "then" should
    // not have to open a task to learn it is somebody else's.
    const line = (t) => `${t.ref}  ${t.title}${t.assignee ? `  · ${t.assignee}` : ''}`
    process.stdout.write(
      `${line(data.pick)}\n  ${data.pick.reason}\n  ${data.pick.priority} · ${data.pick.status}` +
        `\n\n  croft claim ${data.pick.ref}\n` +
        (data.then?.length
          ? `\nthen:\n${data.then.map((t) => `  ${line(t)}`).join('\n')}\n`
          : ''),
    )
  },

  // --- the briefing ------------------------------------------------------

  // --- the lab -----------------------------------------------------------

  /**
   * Subjects: the lab's unit of work — something to explore, prove or build
   * before it becomes real work. `croft subject <verb> S-12 …`.
   */
  async subject() {
    const verb = positional[0]
    const usage = 'usage: croft subject add|list|show|edit|share|publish|stage|note|notes|attach|files|tag|todo …  (croft help)'

    if (verb === 'add') {
      const title = need(positional[1], 'usage: croft subject add "<title>" [--stage S] [--tag t] [--project P] [--owner me] [--body -]')
      const body = { title }
      if (flags.body !== undefined) body.body = await resolveValue(need(flags.body, '--body needs text, or - for stdin'))
      if (flags.stage !== undefined) body.stage = need(flags.stage, '--stage needs a stage name (croft stages)')
      const tags = splitList(flags.tag)
      if (tags.length) body.tags = tags
      if (flags.owner !== undefined) body.owner = need(flags.owner, '--owner needs me or a user id')
      const project = labProjectFlag()
      if (project) body.project = project
      const visibility = visibilityFlag()
      const members = splitList(flags.member)
      if (members.length && visibility !== 'members') {
        die('--member shares the subject with someone: it needs --visibility members')
      }
      if (visibility) body.visibility = visibility
      if (members.length) body.members = members
      const created = await request('POST', '/api/v1/subjects', body)
      if (FORMAT !== 'tsv') return emit(created)
      emitSubjects([created])
      process.stderr.write(`filed ${created.ref} — log as you go: croft subject note ${created.ref} - --kind finding\n`)
      if (created.visibility && created.visibility !== 'lab') {
        process.stderr.write(
          `${created.ref} is ${created.visibility === 'private' ? 'private' : 'shared with its members only'}; ` +
            `croft subject publish ${created.ref} --confirm ${created.ref} puts it in the lab (one-way)\n`,
        )
      }
      return
    }

    if (verb === 'list') {
      const params = new URLSearchParams()
      if (flags.stage) params.set('stage', flags.stage)
      const tags = splitList(flags.tag)
      if (tags.length) params.set('tag', tags.join(','))
      if (flags.mine) params.set('owner', 'me')
      if (flags.project !== undefined) params.set('project', need(flags.project, '--project needs a lab project name, or none (croft projects)'))
      // `include`: live and archived. (`1`/`true` would be archived ONLY.)
      if (flags.all) params.set('archived', 'include')
      const list = await request('GET', `/api/v1/subjects${String(params) ? `?${params}` : ''}`)
      return emitSubjects(list)
    }

    if (verb === 'show') {
      const ref = subjectArg(positional[1], 'usage: croft subject show S-12 [--full]')
      const full = Boolean(flags.full)
      const [subject, notes, todos, humanNotes, files] = await Promise.all([
        request('GET', `/api/v1/subjects/${ref}`),
        request('GET', `/api/v1/subjects/${ref}/notes`, undefined, { soft: true }),
        request('GET', `/api/v1/subjects/${ref}/todos`, undefined, { soft: true }),
        // Soft: a server older than 0.3 has neither, and the digest stands without them.
        request('GET', `/api/v1/subjects/${ref}/human-notes`, undefined, { soft: true }),
        request('GET', `/api/v1/subjects/${ref}/attachments`, undefined, { soft: true }),
      ])
      if (FORMAT !== 'tsv') {
        return emit({
          ...subject,
          notes: asList(notes, 'notes'),
          todos: asList(todos, 'todos'),
          human_notes: asList(humanNotes, 'notes'),
          files: asList(files, 'files'),
        })
      }
      const { text, withheld } = renderSubject({ ...subject, ref: subject.ref ?? ref }, asList(notes, 'notes'), asList(todos, 'todos'), {
        full,
        humanNotes: asList(humanNotes, 'notes'),
        files: asList(files, 'files'),
      })
      process.stdout.write(text)
      if (withheld) {
        process.stderr.write(
          `withheld: ${withheld.body}B of write-up, ${withheld.notes} note(s)` +
            ` — croft subject show ${subject.ref ?? ref} --full is ~${withheld.tokens} tokens\n`,
        )
      }
      return
    }

    if (verb === 'edit') {
      const ref = subjectArg(positional[1], 'usage: croft subject edit S-12 [--title T] [--body -] [--project P|none]')
      const patch = {}
      if (flags.title !== undefined) patch.title = need(flags.title, '--title needs text')
      if (flags.body !== undefined) patch.body = await resolveValue(need(flags.body, '--body needs text, or - for stdin'))
      const project = labProjectFlag()
      if (project !== undefined) patch.project = project
      if (!Object.keys(patch).length) die('nothing to change — pass --title, --body and/or --project')
      const updated = await request('PATCH', `/api/v1/subjects/${ref}`, patch)
      return FORMAT === 'tsv' ? emitSubjects([updated]) : emit(updated)
    }

    if (verb === 'share') {
      const shareUsage = 'usage: croft subject share S-12 +who -who [--visibility members|private]'
      const ref = subjectArg(positional[1], shareUsage)
      const { add, remove } = memberChanges(positional.slice(2))
      const visibility = visibilityFlag()
      if (visibility === 'lab') die(`the lab is one-way: croft subject publish ${ref}`)
      if (!add.length && !remove.length && !visibility) die(shareUsage)
      const onError = visibilityRefusal(ref)
      const current = await request('GET', `/api/v1/subjects/${ref}`)
      if (current.visibility === 'lab' || current.visibility === undefined) {
        die(`${ref} is in the lab: everyone already sees it, and publishing cannot be undone`)
      }
      // The server resolves me, an id, an email or a name, on both verbs; a
      // private subject that gains a member becomes a members one by itself.
      for (const who of add) {
        await request('POST', `/api/v1/subjects/${ref}/members`, { user: who }, { onError })
      }
      for (const who of remove) {
        await request('DELETE', `/api/v1/subjects/${ref}/members/${encodeURIComponent(who)}`, undefined, { onError })
      }
      let updated = await request('GET', `/api/v1/subjects/${ref}`)
      if (visibility && visibility !== updated.visibility) {
        updated = await request('PATCH', `/api/v1/subjects/${ref}`, { visibility }, { onError })
      }
      if (current.visibility === 'private' && updated.visibility === 'members' && !visibility) {
        process.stderr.write(`${ref} was private; it is now shared with its members\n`)
      }
      if (FORMAT !== 'tsv') return emit(updated)
      emitSubjects([updated])
      if (updated.visibility === 'members') {
        const names = (updated.members ?? []).map((m) => cellOf(m)).join(', ')
        process.stderr.write(`${ref} is shared with ${names || 'nobody yet besides its owner'}\n`)
      }
      return
    }

    if (verb === 'publish') {
      const ref = subjectArg(positional[1], 'usage: croft subject publish S-12 --confirm S-12')
      // One-way, so the ref is typed twice, as for a project delete: an agent
      // cannot publish a private subject by getting one argument wrong.
      if (String(flags.confirm ?? '').toUpperCase() !== ref) {
        die(`publishing ${ref} puts it in the lab for everyone, and cannot be undone. Re-run with --confirm ${ref} if that is what you want.`)
      }
      const published = await request('POST', `/api/v1/subjects/${ref}/publish`, {}, { onError: visibilityRefusal(ref) })
      if (FORMAT !== 'tsv') return emit(published)
      emitSubjects([published])
      process.stderr.write(`${ref} is in the lab: everyone sees it now, and that cannot be undone\n`)
      return
    }

    if (verb === 'stage') {
      const ref = subjectArg(positional[1], 'usage: croft subject stage S-12 "<stage>" [--conclusion -]')
      const stage = need(positional[2], `usage: croft subject stage ${ref} "<stage>" [--conclusion -]   (croft stages lists them)`)
      const patch = { stage }
      if (flags.conclusion !== undefined) {
        patch.conclusion = await resolveValue(need(flags.conclusion, '--conclusion needs text, or - for stdin'))
      }
      const updated = await request('PATCH', `/api/v1/subjects/${ref}`, patch, { onError: conclusionRefusal(ref, stage) })
      return FORMAT === 'tsv' ? emitSubjects([updated]) : emit(updated)
    }

    if (verb === 'note') {
      const ref = subjectArg(positional[1], 'usage: croft subject note S-12 "<text>"|- [--kind finding|decision|attempt|note|handoff]')
      const note = await resolveValue(need(positional[2], 'a note body is required ("<text>", or - for stdin)'))
      const kind = flags.kind ?? 'note'
      if (!SUBJECT_NOTE_KINDS.includes(kind)) die(`--kind must be one of ${SUBJECT_NOTE_KINDS.join(', ')}`)
      emit(await request('POST', `/api/v1/subjects/${ref}/notes`, { note, kind }))
      if (!flags.kind && FORMAT === 'tsv' && DEAD_END.test(note)) {
        process.stderr.write(
          `reads like a dead end — \`croft subject note ${ref} - --kind attempt\` marks it so the next agent does not retry it\n`,
        )
      }
      return
    }

    if (verb === 'notes') {
      // People's notes (the board's Notes tab), not the work log: read them, write to the log.
      const ref = subjectArg(positional[1], 'usage: croft subject notes S-12')
      const list = asList(await request('GET', `/api/v1/subjects/${ref}/human-notes`), 'notes')
      return emit(list, {
        lines: (d) =>
          d.length === 0
            ? [`no notes from people on ${ref}`]
            : d.flatMap((n) => [
                `${DAY(n.created_at)}  ${n.author?.name ?? ''}${n.updated_at && n.updated_at !== n.created_at ? `  (edited ${DAY(n.updated_at)})` : ''}`,
                ...indent(String(n.body ?? ''), '    '),
              ]),
      })
    }

    if (verb === 'attach') {
      const ref = subjectArg(positional[1], 'usage: croft subject attach S-12 <file>')
      const file = need(positional[2], `usage: croft subject attach ${ref} <file>`)
      if (!existsSync(file)) die(`no such file: ${file}`)
      process.stderr.write(`uploading ${basename(file)} (${statSync(file).size} bytes, ${mimeOf(file)})\n`)
      const added = await upload(`/api/v1/subjects/${ref}/attachments`, file)
      if (FORMAT !== 'tsv') return emit(added)
      if (added?.kind === 'image' && added.content_url) {
        process.stderr.write(`embed it in the write-up with ![${added.filename}](${added.content_url})\n`)
      }
      return emit([added], { rows: (d) => d.map(fileRow), columns: FILE_COLUMNS })
    }

    if (verb === 'files') {
      const ref = subjectArg(positional[1], 'usage: croft subject files S-12')
      const list = await request('GET', `/api/v1/subjects/${ref}/attachments`)
      return emit(list, { rows: (d) => asList(d, 'files').map(fileRow), columns: FILE_COLUMNS })
    }

    if (verb === 'tag') {
      const ref = subjectArg(positional[1], 'usage: croft subject tag S-12 +x -y')
      const { add, remove } = tagChanges(positional.slice(2))
      if (!add.length && !remove.length) die(`usage: croft subject tag ${ref} +x -y   (croft tags lists them)`)
      const current = await request('GET', `/api/v1/subjects/${ref}`)
      const names = new Set((current.tags ?? []).map((t) => cellOf(t).toLowerCase()))
      for (const t of add) names.add(t)
      for (const t of remove) names.delete(t)
      const updated = await request('PATCH', `/api/v1/subjects/${ref}`, { tags: [...names] })
      return FORMAT === 'tsv' ? emitSubjects([updated]) : emit(updated)
    }

    if (verb === 'todo') {
      const ref = subjectArg(positional[1], 'usage: croft subject todo S-12 "<title>" [--body -]')
      const title = need(positional[2], `usage: croft subject todo ${ref} "<title>" [--body -]`)
      const body = { title }
      if (flags.body !== undefined) body.description = await resolveValue(need(flags.body, '--body needs text, or - for stdin'))
      for (const k of ['type', 'priority']) if (flags[k]) body[k] = flags[k]
      const todo = await request('POST', `/api/v1/subjects/${ref}/todos`, body)
      const todoRef = todo.ref ?? refOfTask(todo)
      // As `add` does for a runtime: the agent filing a todo is about to do it.
      const start = Boolean(flags.start) || (!flags['no-start'] && Boolean(AGENT))
      let shown = todo
      if (start && todoRef) {
        const held = await request('POST', `/api/v1/tasks/${todoRef}/claim`, {}, { soft: !flags.start })
        if (held) {
          shown = { ...todo, status: held.status ?? todo.status, claimed_by: held.claimed_by ?? todo.claimed_by }
          if (!flags.start) process.stderr.write(`claimed ${todoRef} (agents' todos start the work; --no-start to only file it)\n`)
        } else {
          process.stderr.write(`filed ${todoRef} but could not claim it — \`croft claim ${todoRef}\`\n`)
        }
      }
      if (FORMAT !== 'tsv') return emit(shown)
      return emit([shown], { rows: (d) => d.map(todoRow), columns: ['ref', 'status', 'held', 'cairn', 'title'] })
    }

    die(verb ? `unknown subject verb "${verb}"\n${usage}` : usage)
  },

  async stages() {
    const stages = await request('GET', '/api/v1/stages')
    emit(stages, {
      rows: (d) =>
        [...asList(d, 'stages')]
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map((s) => ({ stage: s.name, category: s.category, conclusion: CONCLUDING.has(s.category) ? 'required' : '' })),
      columns: ['stage', 'category', 'conclusion'],
    })
  },

  async tags() {
    const tags = await request('GET', '/api/v1/tags')
    emit(tags, {
      rows: (d) => [...asList(d, 'tags')].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((t) => ({ tag: t.name, color: t.color ?? '' })),
      columns: ['tag', 'color'],
    })
  },

  /**
   * Two verbs under one name, told apart by --to.
   *
   * `push T-41 --to CAIRN` is the hand-over: the lab has proved the idea and
   * a repo is about to change for real, which is Cairn's work. It files the
   * todo in Cairn through Cairn's own CLI (so Cairn's routing, keys and
   * checks apply) and records the link; from then on Cairn owns the status
   * and `croft sync` reads it back.
   *
   * `push <ref> <sha>` records a git push, as it always has.
   */
  async push() {
    const ref = need(positional[0], 'usage: croft push T-41 [--to <CAIRN_KEY>]   |   croft push <ref> <sha>')

    if (flags.link !== undefined) {
      const cairnRef = String(need(flags.link, '--link needs the Cairn ref, e.g. --link CAIRN-331')).toUpperCase()
      if (!/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(cairnRef)) die(`"${cairnRef}" is not a Cairn task ref`)
      return emit(await request('POST', `/api/v1/tasks/${ref}/cairn-link`, { cairnRef, ...(flags.force ? { force: true } : {}) }, {
        onError: unpublishedRefusal(ref),
      }))
    }

    if (flags.to === undefined && positional[1] !== undefined) {
      const sha = positional[1]
      const payload = { event: 'git_push', sha }
      if (flags.repo) payload.repo = flags.repo
      if (flags.branch) payload.branch = flags.branch
      if (flags.remote) payload.remote = flags.remote
      if (flags.url) payload.url = flags.url
      return emit(await request('POST', `/api/v1/tasks/${ref}/activity`, payload))
    }

    // An explicit --to wins; without one, the subject's lab project says where.
    let key = flags.to === undefined ? null : String(need(flags.to, '--to needs the Cairn project key, e.g. --to CAIRN')).toUpperCase()
    if (key && !/^[A-Z][A-Z0-9]{0,9}$/.test(key)) die(`"${key}" is not a Cairn project key`)
    const bin = resolveCairn()
    if (!bin) die(NO_CAIRN)

    const todo = await request('GET', `/api/v1/tasks/${ref}`)
    const todoRef = refOfTask(todo) ?? ref
    if (todo.cairn_ref && !flags.force) {
      die(`${todoRef} is already paired with ${todo.cairn_ref} — \`croft sync\` pulls its status; --force files another`)
    }
    // Checked here, before Cairn is touched: the server refuses the link too,
    // but by then the Cairn task would already exist.
    const visibility = todo.subject?.visibility
    if (visibility && visibility !== 'lab' && !flags.force) die(unpublishedMessage(todoRef, todo.subject.ref, visibility))
    if (!key) {
      const target = pushTarget(todo, todoRef)
      if (!target.key) die(target.why)
      key = target.key
      process.stderr.write(`filing in ${key}, ${todo.subject.project.name}'s Cairn project\n`)
    }
    const subjectRef =
      todo.subject?.ref ?? todo.subject_ref ?? (todo.subject_number ? `S-${todo.subject_number}` : null)
    const type = flags.type ?? CAIRN_TYPES[todo.type] ?? 'feature'
    const description = String(todo.description ?? '').trim()
    const body = [description, `From Croft ${todoRef}${subjectRef ? ` (subject ${subjectRef})` : ''}`]
      .filter(Boolean)
      .join('\n\n')
    const args = ['add', todo.title, '--project', key, '--type', type, '--label', `croft:${todoRef}`, '--body', '-', '--no-start']
    // Cairn refuses a bug or spike with no real body; the line saying where it
    // came from is not one, and the description is what there is.
    if (!description && ['bug', 'spike'].includes(type)) args.push('--force-empty')

    const run = runCairn(bin, args, body)
    if (run.error) die(`could not run ${bin}: ${run.error.message}`)
    if (run.stderr) process.stderr.write(run.stderr.replace(/^/gm, 'cairn: '))
    if (run.status !== 0) die(`cairn add failed (exit ${run.status}); nothing was linked`, run.status === UNDECIDED_EXIT ? UNDECIDED_EXIT : 1)
    const cairnRef = parseCairnRef(run.stdout)
    if (!cairnRef) {
      die(
        `cairn add exited 0 but named no task ref:\n${String(run.stdout).slice(0, 400)}\n` +
          `find it in Cairn (label croft:${todoRef}) and record it: croft push ${todoRef} --link <CAIRN-REF>`,
      )
    }
    // Said before the link is recorded, so a failure below still leaves the
    // ref on screen rather than a Cairn task nobody knows was filed.
    process.stderr.write(`filed ${cairnRef} in Cairn\n`)
    const linked = await request('POST', `/api/v1/tasks/${todoRef}/cairn-link`, { cairnRef, ...(flags.force ? { force: true } : {}) }, {
      onError: (payload) =>
        die(`${cairnRef} was filed, but Croft refused the link: ${payload.error}\nrecord it once that is fixed: croft push ${todoRef} --link ${cairnRef}`),
    })
    if (FORMAT !== 'tsv') return emit({ ref: todoRef, cairnRef, ...(linked && typeof linked === 'object' ? linked : {}) })
    emit([{ ref: todoRef, cairn: cairnRef, subject: subjectRef ?? '', title: truncate(todo.title, 70) }], {
      columns: ['ref', 'cairn', 'subject', 'title'],
    })
    process.stderr.write(
      `${todoRef} -> ${cairnRef}: Cairn owns its status from here (\`cairn claim ${cairnRef}\` when you start it); ` +
        '`croft sync` pulls it back\n',
    )
  },

  /**
   * Pull the status of every paired todo back from Cairn. The server does it
   * when an admin has connected Cairn; otherwise this machine does, through
   * the cairn CLI and its own keys.
   */
  async sync() {
    let refusal = null
    let status = 0
    const data = await request('POST', '/api/v1/integrations/cairn/sync', {}, {
      soft: true,
      onError: (payload, code) => {
        refusal = payload
        status = code
      },
    })
    if (data) {
      if (FORMAT !== 'tsv' || !Array.isArray(data.results)) return emit(data)
      emit(data.results, {
        rows: (d) => d.map((r) => ({ ref: r.ref ?? '', cairn: r.cairnRef ?? r.cairn_ref ?? '', status: r.cairnStatus ?? r.cairn_status ?? '', result: r.result ?? '' })),
        columns: ['ref', 'cairn', 'status', 'result'],
      })
      if (typeof data.checked === 'number') {
        const unread = Array.isArray(data.failed) ? data.failed.length : 0
        process.stderr.write(
          `${data.checked} checked, ${data.updated ?? 0} changed, ${data.concluded ?? 0} noted, ${data.closed ?? 0} closed` +
            `${unread ? `, ${unread} unread` : ''}\n`,
        )
      }
      return
    }
    const notConfigured =
      status === 404 || CAIRN_NOT_CONFIGURED.has(refusal?.code) || /not configured|no cairn connection/i.test(refusal?.error ?? '')
    if (!notConfigured) die(`croft sync: ${refusal?.error ?? 'the server did not answer'}`)

    const bin = resolveCairn()
    if (!bin) {
      die('the server has no Cairn connection (an admin can add one in Settings), and this machine has no cairn CLI to sync through')
    }
    process.stderr.write('the server has no Cairn connection; syncing through this machine\'s cairn CLI\n')
    const rows = []
    for (const todo of await linkedTodos()) {
      const run = runCairn(bin, ['show', todo.cairn_ref, '--json'])
      let cairnTask = null
      try {
        cairnTask = run.status === 0 ? JSON.parse(run.stdout) : null
      } catch {
        cairnTask = null
      }
      const cairnStatus = cairnTask?.status
      if (!cairnStatus) {
        const why = String(run.stderr || run.error?.message || `exit ${run.status}`).trim().split('\n')[0]
        rows.push({ ref: todo.ref, cairn: todo.cairn_ref, status: todo.cairn_status ?? '', result: `unread: ${truncate(why, 60)}` })
        continue
      }
      // An ended Cairn task whose todo is still open is sent again: the
      // server closes the todo (Cairn owns its status once pushed).
      const ended = TERMINAL.has(cairnStatus)
      const stillOpen = ended && todo.status !== undefined && !TERMINAL.has(todo.status)
      if (cairnStatus === todo.cairn_status && !stillOpen) {
        rows.push({ ref: todo.ref, cairn: todo.cairn_ref, status: cairnStatus, result: 'unchanged' })
        continue
      }
      const link = { cairnRef: todo.cairn_ref, cairnStatus }
      // What the server's sync would have written: `CAIRN-331 done: <resolution>`.
      if (ended && cairnTask.resolution) link.cairnResolution = String(cairnTask.resolution)
      if (ended && (cairnTask.resolution_kind ?? cairnTask.resolutionKind)) {
        link.cairnResolutionKind = String(cairnTask.resolution_kind ?? cairnTask.resolutionKind)
      }
      const linked = await request('POST', `/api/v1/tasks/${todo.ref}/cairn-link`, link)
      const result = [
        cairnStatus === todo.cairn_status ? 'unchanged' : `was ${todo.cairn_status ?? 'unknown'}`,
        linked?.noted ? 'noted' : '',
        linked?.closed ? 'closed' : '',
      ].filter(Boolean).join(' · ')
      rows.push({ ref: todo.ref, cairn: todo.cairn_ref, status: cairnStatus, result })
    }
    emit(rows, { columns: ['ref', 'cairn', 'status', 'result'] })
  },

  async context() {
    if (flags.brief) return brief()
    const cwd = flags.cwd ?? process.cwd()
    const params = new URLSearchParams()
    if (SHARE_LOCATION) params.set('cwd', cwd)
    const project = flags.project ?? projectForDir(cwd)
    if (project) params.set('project', project)
    if (flags.scope !== undefined) {
      if (flags.scope !== 'project' && flags.scope !== 'all') die('--scope must be project or all')
      params.set('scope', flags.scope)
    }
    // Costs one local git call and answers where the map cannot: a second
    // clone, a moved directory, a worktree.
    const repo = SHARE_LOCATION ? gitRemote(cwd) : null
    if (repo) params.set('repo', repo)
    if (flags.file) params.set('file', flags.file)
    const data = await request('GET', `/api/v1/context?${params}`)
    if (FORMAT === 'json') return emit(data)
    process.stdout.write(renderContext(data, { fileOnly: Boolean(flags.file) }))
  },

  /**
   * Which instance a directory belongs to, and saving the answer. Local only,
   * like `instance`: the point is to be usable exactly when nothing is routed.
   */
  async route() {
    const sub = positional[0] ?? 'show'
    if (!INSTANCES) die('this machine has one instance (no ~/.croft/instances.json); there is nothing to route', 2)
    if (INSTANCES.error) die(`croft: ${INSTANCES.error}`, 2)
    const dir = flags.dir ? realDir(String(flags.dir)) : ROUTE_DIR
    const { key, repo } = routeKey(dir)

    if (sub === 'show') {
      return emit(INSTANCE.name
        ? { path: tilde(key), instance: INSTANCE.name, why: INSTANCE.why }
        : { path: tilde(key), instance: null, why: INSTANCE.error ?? 'nothing routes it' })
    }
    if (sub === 'list') {
      return emit(INSTANCES.routes.map((r) => ({ path: tilde(r.path), match: r.match, instance: r.instance })))
    }
    if (sub === 'remove') {
      const match = flags.folder ? 'folder' : 'exact'
      const routes = INSTANCES.routes.filter((r) => !(r.match === match && r.path === key))
      if (routes.length === INSTANCES.routes.length) die(`no ${match} route for ${tilde(key)}`)
      writeInstancesConfig({ ...INSTANCES.raw, version: 1, routes })
      return emit({ removed: tilde(key), match })
    }
    if (sub !== 'add') die('usage: croft route [show|list|add <instance> [--folder|--session] [--dir D] [--force]|remove [--folder] [--dir D]]')

    const instance = need(positional[1], 'usage: croft route add <instance> [--folder | --session] [--dir <path>] [--force]')
    if (flags.folder && flags.session) die('--folder and --session are different answers; give one')
    if (flags.session && !ROUTE_SESSION) die('--session needs a session id (CROFT_SESSION_ID), and this shell has none')
    const config = { ...INSTANCES.raw, version: 1, instances: INSTANCES.instances, routes: INSTANCES.routes, raw: INSTANCES.raw }
    const problem = saveRoute(config, {
      instance,
      key,
      folder: Boolean(flags.folder),
      session: flags.session ? ROUTE_SESSION : null,
      force: Boolean(flags.force),
    })
    if (problem) die(`croft: ${problem}`, 2)

    const scope = flags.session ? 'this session' : flags.folder ? `${tilde(key)} and everything under it` : `${repo ? 'repository' : 'directory'} ${tilde(key)}`
    return emit({ instance, scope }, { lines: (d) => [`${d.scope} -> ${d.instance}`] })
  },

  /**
   * Which instance this command would use, every instance configured, or one
   * more. Local only: none of these reads a key or contacts a server, so they
   * work on a machine whose configuration is exactly what needs looking at.
   */
  async instance() {
    const sub = positional[0] ?? 'show'
    if (sub === 'show') {
      if (INSTANCES?.error) die(`croft: ${INSTANCES.error}`, 2)
      const shown = INSTANCE.name
        ? { instance: INSTANCE.name, why: INSTANCE.why, url: BASE, state: STATE_LABEL }
        : INSTANCES
          ? { instance: null, reason: INSTANCE.error ?? 'none chosen for this command' }
          : { instance: null, reason: 'this machine has one instance (no ~/.croft/instances.json)', url: BASE, state: STATE_LABEL }
      return emit(shown)
    }
    if (sub === 'list') {
      if (!INSTANCES) return emit([], { lines: () => ['one instance (no ~/.croft/instances.json)'] })
      if (INSTANCES.error) die(`croft: ${INSTANCES.error}`, 2)
      return emit(Object.entries(INSTANCES.instances).map(([name, { url }]) => ({
        instance: name,
        url,
        default: INSTANCES.unclassified.mode === 'default' && INSTANCES.unclassified.instance === name ? 'yes' : undefined,
        keys: existsSync(join(CROFT_DIR, 'instances', name, 'env'))
          ? Object.keys(fileEnv(join(CROFT_DIR, 'instances', name, 'env'))).filter((k) => k.startsWith('CROFT_API_KEY')).length
          : 0,
      })))
    }
    if (sub === 'policy') {
      if (!INSTANCES) die('this machine has one instance (no ~/.croft/instances.json); there is nothing to choose between', 2)
      if (INSTANCES.error) die(`croft: ${INSTANCES.error}`, 2)
      const mode = positional[1]
      const instance = positional[2]
      if (mode === 'default' && !INSTANCES.instances[instance]) {
        die(`usage: croft instance policy default <${Object.keys(INSTANCES.instances).join('|')}>`)
      }
      if (mode !== 'ask' && mode !== 'default') die('usage: croft instance policy ask | default <name>')
      const unclassified = mode === 'ask' ? { mode: 'ask' } : { mode: 'default', instance }
      writeInstancesConfig({ ...INSTANCES.raw, version: 1, unclassified })
      return emit({ unclassified }, {
        lines: () => [mode === 'ask'
          ? 'a directory with no route: commands stop and ask which instance'
          : `a directory with no route: commands use ${instance}`],
      })
    }
    if (sub !== 'add') die('usage: croft instance [show|list|policy ask|default <name>|add <name> --url <url> [--default] [--adopt]]')

    const name = need(positional[1], 'usage: croft instance add <name> --url <url> [--default] [--adopt]')
    if (!INSTANCE_NAME.test(name)) die(`"${name}" is not an instance name: lowercase letters, digits and dashes, up to 32`)
    const url = trimUrl(need(flags.url, 'croft instance add needs --url <the server this instance is>'))
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error()
    } catch {
      die(`--url ${url} is not an http(s) URL`)
    }
    if (INSTANCES?.error) die(`croft: ${INSTANCES.error} — fix it before adding to it`, 2)

    // The one question setup has to put to a person: with a second instance,
    // what happens in a directory nobody has classified. Asked once, at a
    // terminal, only when --default did not already answer it, and before
    // anything is moved, so an abandoned prompt leaves nothing half done.
    const decided = flags.default || INSTANCES?.raw?.unclassified != null
    const willHaveSeveral = INSTANCES ? new Set([...Object.keys(INSTANCES.instances), name]).size > 1 : false
    let unclassified
    if (!decided && willHaveSeveral && process.stdin.isTTY && process.stderr.isTTY) {
      const policy = await askPolicy({ ...(INSTANCES?.instances ?? {}), [name]: { url } })
      if (policy) unclassified = policy
    }

    let result
    try {
      result = await addInstance({ name, url, makeDefault: Boolean(flags.default), adopt: Boolean(flags.adopt), unclassified })
    } catch (error) {
      die(error.message)
    }
    return emit({ instance: name, url, default: flags.default ? 'yes' : undefined, notes: result.notes }, {
      lines: (d) => [`instance ${d.instance} -> ${d.url}${d.default ? ' (default)' : ''}`, ...d.notes.map((n) => `  ${n}`)],
    })
  },

  /**
   * One command that connects this machine to a Croft instance and installs
   * everything the four scripts and the README's hand-copying used to do
   * separately: keys, the CLI itself, the skill, the hooks, and the
   * maintenance jobs. Idempotent — re-running it is the upgrade path, keeping
   * keys and replacing files only where they differ. `--dry-run` prints the
   * plan and writes nothing; every step below checks it before touching disk
   * or the network (bar a handful of read-only GETs that a plan is honest to
   * make: the health check, and confirming an existing key still works).
   */
  async setup() {
    const dry = Boolean(flags['dry-run'])
    const explicitName = typeof flags.name === 'string' ? flags.name.trim() : undefined
    const say = (s) => process.stdout.write(s)
    const line = (s) => say(`${s}\n`)

    const assertHttpUrl = (u) => {
      try {
        if (!['http:', 'https:'].includes(new URL(u).protocol)) throw new Error()
      } catch {
        die(`--url ${u} is not an http(s) URL`)
      }
    }

    // --- 1. which instance, and where its keys live -------------------------
    const topEnvPath = join(CROFT_DIR, 'env')
    const hasInstances = existsSync(INSTANCES_PATH)
    const topEnv = fileEnv(topEnvPath)
    const requestedUrl = flags.url ? trimUrl(String(flags.url)) : null
    if (requestedUrl) assertHttpUrl(requestedUrl)
    const existingTopUrl = topEnv.CROFT_BASE_URL ? trimUrl(topEnv.CROFT_BASE_URL) : null
    const multiInstance = hasInstances || (existingTopUrl != null && requestedUrl != null && existingTopUrl !== requestedUrl)

    let instanceName = null
    let url
    let envPath

    if (!multiInstance) {
      url = requestedUrl || existingTopUrl
      if (!url) die('croft setup needs --url <the Croft instance to connect this machine to>, the first time it runs')
      envPath = topEnvPath
      if (existingTopUrl === url) {
        line(`– instance  ${url} (already configured)`)
      } else if (dry) {
        line(`! instance  would write CROFT_BASE_URL=${url} to ~/.croft/env`)
      } else {
        setEnvKeys(topEnvPath, { CROFT_BASE_URL: url })
        line(`✓ instance  ${url} -> ~/.croft/env`)
      }
    } else {
      if (hasInstances && INSTANCES?.error) die(`croft: ${INSTANCES.error}`, 2)
      const already = requestedUrl && INSTANCES
        ? Object.entries(INSTANCES.instances).find(([, i]) => trimUrl(i.url) === requestedUrl)
        : null
      if (already) {
        ;[instanceName] = already
        url = trimUrl(already[1].url)
        line(`– instance  ${instanceName} -> ${url} (already registered)`)
      } else {
        url = requestedUrl
        if (!url) die('croft setup needs --url <the Croft instance to connect this machine to> (this machine already has others)')
        if (explicitName && !INSTANCE_NAME.test(explicitName)) {
          die(`"${explicitName}" is not an instance name: lowercase letters, digits and dashes, up to 32`)
        }
        instanceName = explicitName || deriveInstanceName(url)
        // A machine connected to one instance keeps its keys in ~/.croft/env,
        // which is no longer read once instances are configured. Adopt it as an
        // instance of its own first, still the default, or adding a second one
        // would quietly disconnect the first.
        const adopting = !hasInstances && existingTopUrl && existingTopUrl !== url
        let adoptedName = adopting ? deriveInstanceName(existingTopUrl) : null
        if (adoptedName === instanceName) adoptedName = `${adoptedName}-1`
        if (dry) {
          if (adopting) line(`! instance  would adopt ~/.croft/env as ${adoptedName} -> ${existingTopUrl} (still the default)`)
          line(`! instance  would register ${instanceName} -> ${url}`)
        } else {
          if (adopting) {
            try {
              await addInstance({ name: adoptedName, url: existingTopUrl, adopt: true, makeDefault: true, pairing: true })
            } catch (error) {
              die(error.message)
            }
            line(`✓ instance  ${adoptedName} -> ${existingTopUrl} (adopted from ~/.croft/env, still the default)`)
          }
          let result
          try {
            result = await addInstance({ name: instanceName, url, pairing: true })
          } catch (error) {
            die(error.message)
          }
          line(`✓ instance  ${instanceName} -> ${url}`)
          for (const note of result.notes) line(`   ${note}`)
        }
      }
      envPath = join(instanceDir(instanceName), 'env')
    }

    // --- 2. server check ------------------------------------------------------
    let serverInfo = null
    try {
      const res = await fetch(`${url}/api/v1/health`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      serverInfo = (await res.json())?.data ?? {}
      line(`✓ server    ${url} (${serverInfo.version ?? '?'}${serverInfo.build && serverInfo.build !== 'unknown' ? ` ${serverInfo.build}` : ''})`)
    } catch (error) {
      die(`croft setup: cannot reach ${url}/api/v1/health (${error.message})`)
    }

    // --- 3. runtimes, and which of them already have a working key ----------
    const runtimes = flags.runtimes
      ? String(flags.runtimes).split(',').map((r) => r.trim()).filter(Boolean)
      : detectSetupRuntimes()
    if (flags.maintenance && !runtimes.includes('maintenance')) runtimes.push('maintenance')
    if (!runtimes.length) {
      die('croft setup found no runtime on this machine (looked for ~/.claude, ~/.codex, openclaw) — pass --runtimes a,b')
    }

    const existingEnv = fileEnv(envPath)
    const kept = []
    const missingRuntimes = []
    for (const runtime of runtimes) {
      const key = existingEnv[keyNameFor(runtime)]
      if (key && (await keyIsValid(url, key))) kept.push(runtime)
      else missingRuntimes.push(runtime)
    }
    if (kept.length) line(`– keys      ${kept.join(', ')} already set, and still work`)

    // --- 4. pair for whatever is missing --------------------------------------
    let issuedKeys = []
    if (missingRuntimes.length && dry) {
      line(`! keys      ${missingRuntimes.join(', ')} would be paired (--dry-run: skipped)`)
    } else if (missingRuntimes.length) {
      // A maintenance key needs an administrator's approval (it releases anyone's
      // claims), so it is asked for on its own: a member approving their own
      // agents must not have that request fail for the sake of one they cannot
      // grant.
      const privileged = missingRuntimes.filter((runtime) => runtime === 'maintenance')
      const ordinary = missingRuntimes.filter((runtime) => runtime !== 'maintenance')
      for (const group of [ordinary, privileged]) {
        if (!group.length) continue
        if (group === privileged) line('  the maintenance key needs an administrator to approve it')
        let result
        try {
          result = await pairDevice({ baseUrl: url, runtimes: group, write: say })
        } catch (error) {
          die(`croft setup: ${error.message}`)
        }
        if (result.fallback) {
          line('! keys      this server predates pairing (404 on /api/v1/connect);')
          line(`            ask an admin for keys on ${url}/users and put them in ${tilde(envPath)} as:`)
          for (const runtime of missingRuntimes) line(`              ${keyNameFor(runtime)}=…`)
          break
        }
        if (group === privileged && (result.denied || result.expired)) {
          line('! keys      maintenance not issued — it takes an administrator\'s approval')
          continue
        }
        if (result.denied) die('croft setup: pairing was denied')
        if (result.expired) die('croft setup: pairing expired before it was approved; run `croft setup` again')
        issuedKeys = [...issuedKeys, ...(result.keys ?? [])]
      }
    }
    if (issuedKeys.length) {
      const updates = {}
      for (const { agentName, key } of issuedKeys) updates[keyNameFor(agentName)] = key
      setEnvKeys(envPath, updates)
      line(`✓ keys      ${issuedKeys.map((k) => k.agentName).join(', ')} -> ${tilde(envPath)}`)
    }

    // --- 5. release files ------------------------------------------------------
    const localSource = process.env.CROFT_SETUP_SOURCE
    // The repository the release comes from, and the one whose tag the
    // agent-files job then follows: CROFT_REPO, as install.sh reads it, so a
    // machine installed from a fork is not handed the public release halfway.
    const setupRepo = process.env.CROFT_REPO?.trim() || 'montytorr/croft'
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(setupRepo) || setupRepo.includes('..') || /(^|\/)\.(\/|$)/.test(setupRepo)) {
      die(`CROFT_REPO=${JSON.stringify(setupRepo)} is not <owner>/<name>`)
    }
    const releaseDir = localSource || join(CROFT_DIR, 'releases', VERSION)
    const releaseParts = ['scripts', 'hooks', 'skills', 'cli']
    const haveRelease = releaseParts.every((p) => existsSync(join(releaseDir, p)))
    if (localSource) {
      if (!haveRelease) die(`CROFT_SETUP_SOURCE=${localSource} is missing one of ${releaseParts.join(', ')}`)
      line(`– source    ${localSource} (CROFT_SETUP_SOURCE)`)
    } else if (haveRelease) {
      line(`– release   v${VERSION} already downloaded (~/.croft/releases/${VERSION})`)
    } else if (dry) {
      line(`! release   would download v${VERSION} from github.com/${setupRepo}`)
    } else {
      const tarUrl = `https://codeload.github.com/${setupRepo}/tar.gz/refs/tags/v${VERSION}`
      let res
      try {
        res = await fetch(tarUrl)
      } catch (error) {
        die(`croft setup: could not download ${tarUrl} (${error.message})`)
      }
      if (!res.ok) die(`croft setup: could not download ${tarUrl} (${res.status}) — is v${VERSION} released yet?`)
      mkdirSync(releaseDir, { recursive: true })
      const buf = Buffer.from(await res.arrayBuffer())
      const members = releaseParts.flatMap((p) => [`*/${p}`])
      let extract = spawnSync('tar', ['-xzf', '-', '--strip-components=1', '-C', releaseDir, ...members], { input: buf, stdio: ['pipe', 'pipe', 'pipe'] })
      if (extract.status !== 0) {
        // An older tar, or one that does not glob member names by default:
        // take the whole tree rather than fail setup over five directories
        // nobody minds having on disk.
        extract = spawnSync('tar', ['-xzf', '-', '--strip-components=1', '-C', releaseDir], { input: buf, stdio: ['pipe', 'pipe', 'pipe'] })
      }
      if (extract.status !== 0) {
        die(`croft setup: tar could not extract the release (${extract.stderr?.toString().trim() || extract.status})`)
      }
      if (!releaseParts.every((p) => existsSync(join(releaseDir, p)))) {
        die(`croft setup: v${VERSION}'s release archive is missing one of ${releaseParts.join(', ')}`)
      }
      line(`✓ release   v${VERSION} -> ~/.croft/releases/${VERSION}`)
    }

    // A dry run that has never downloaded a release yet has nothing on disk to
    // read the rest of the plan from — say so once, plainly, rather than a
    // false "unchanged" for files that were never compared.
    const releaseReady = existsSync(join(releaseDir, 'cli', 'croft.mjs'))
    if (!releaseReady) {
      line('! plan      cli, skill, hooks, jobs skipped — no release on disk yet to plan from;')
      line('   run once without --dry-run, or set CROFT_SETUP_SOURCE to a checkout')
    } else {
      // --- 6. the CLI itself -----------------------------------------------------
      const cliTarget = join(HOME, '.local', 'bin', 'croft')
      const releaseCli = readFileSync(join(releaseDir, 'cli', 'croft.mjs'))
      const cliChanged = !existsSync(cliTarget) || !readFileSync(cliTarget).equals(releaseCli)
      if (!cliChanged) {
        line(`– cli       ${tilde(cliTarget)} (${VERSION}) — unchanged`)
      } else if (dry) {
        line(`! cli       would write ${tilde(cliTarget)} (${VERSION})`)
      } else {
        mkdirSync(dirname(cliTarget), { recursive: true })
        writeFileSync(cliTarget, releaseCli, { mode: 0o755 })
        line(`✓ cli       ${tilde(cliTarget)} (${VERSION})`)
      }
      if (!onSetupPath('croft')) {
        line('! path      ~/.local/bin is not on PATH — add: export PATH="$HOME/.local/bin:$PATH"')
      }

      // --- 7. skill ----------------------------------------------------------------
      if (flags['no-skill']) {
        line('– skill     skipped (--no-skill)')
      } else {
        const skillSource = join(releaseDir, 'skills', 'croft', 'SKILL.md')
        const skillSourceBuf = existsSync(skillSource) ? readFileSync(skillSource) : null
        const skillTargets = []
        if (runtimes.includes('claude-code')) skillTargets.push(join(HOME, '.claude', 'skills', 'croft', 'SKILL.md'))
        if (runtimes.includes('codex')) skillTargets.push(join(HOME, '.codex', 'skills', 'croft', 'SKILL.md'))
        if (runtimes.includes('openclaw')) {
          const clawdHome = process.env.CLAWD_HOME?.trim()
          if (clawdHome) skillTargets.push(join(clawdHome, 'skills', 'croft', 'SKILL.md'))
          else line('! skill     openclaw: $CLAWD_HOME is not set — copy skills/croft to its skills directory by hand')
        }
        if (!skillSourceBuf && skillTargets.length) {
          line(`! skill     ${skillSource} not found in the release — skipped`)
        } else if (dry) {
          const changed = skillTargets.filter((t) => !(existsSync(t) && readFileSync(t).equals(skillSourceBuf)))
          if (changed.length) line(`! skill     would write ${changed.map((t) => tilde(dirname(t))).join(', ')}`)
          else if (skillTargets.length) line(`– skill     ${skillTargets.map((t) => tilde(dirname(t))).join(', ')} — unchanged`)
        } else {
          const written = []
          for (const target of skillTargets) {
            if (existsSync(target) && readFileSync(target).equals(skillSourceBuf)) continue
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, skillSourceBuf)
            written.push(tilde(dirname(target)))
          }
          if (written.length) line(`✓ skill     ${written.join(', ')}`)
          else if (skillTargets.length) line(`– skill     ${skillTargets.map((t) => tilde(dirname(t))).join(', ')} — unchanged`)
        }
      }

      // --- 8. hooks ------------------------------------------------------------------
      if (flags['no-hooks']) {
        line('– hooks     skipped (--no-hooks)')
      } else {
        // Only the runtimes this setup paired keys for: a hook in a runtime with no
        // key cannot run, and a runtime the person did not choose is not ours to edit.
        const result = spawnSync(
          process.execPath,
          [join(releaseDir, 'scripts', 'install-hooks.mjs'), '--runtimes', runtimes.join(','), ...(dry ? ['--dry-run'] : [])],
          { encoding: 'utf8' },
        )
        line(`${dry ? '!' : '✓'} hooks     ${dry ? 'would install:' : 'installed:'}`)
        for (const l of `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n')) if (l.trim()) line(`   ${l}`)
      }

      // --- 9. maintenance jobs ---------------------------------------------------------
      if (flags['no-jobs']) {
        line('– jobs      skipped (--no-jobs)')
      } else {
        const jobs = ['agent-files', ...(flags.maintenance ? ['reconcile'] : [])]
        // What the one job every machine gets actually does, said before it is
        // installed rather than left to be found in a plist: it overwrites code
        // every agent session runs, on a timer.
        const rawBase = process.env.CROFT_RAW_BASE?.trim()
        const followed = rawBase
          ? `${rawBase} (CROFT_RAW_BASE — follows that URL as it moves, unless it names a tag)`
          : `v${VERSION}, the release installed here, from ${process.env.CROFT_RAW_REPO?.trim() || `github.com/${setupRepo}`}`
        line(`– job       agent-files keeps ${tilde(join(HOME, '.local', 'bin', 'croft'))}, ~/.croft/hooks and the skill equal to`)
        line(`   ${followed},`)
        line(`   ${process.platform === 'darwin' ? 'every 15 minutes and at login' : 'hourly'}, overwriting any copy that differs. It never replaces`)
        line('   itself from the network and never moves to a newer release: re-run setup for that.')
        line(`   --no-jobs skips it; node ${tilde(join(releaseDir, 'scripts', 'install-cron.mjs'))} --remove --only agent-files takes it out`)
        const result = spawnSync(
          process.execPath,
          [join(releaseDir, 'scripts', 'install-cron.mjs'), ...(dry ? [] : ['--install']), '--only', jobs.join(',')],
          { encoding: 'utf8' },
        )
        line(`${dry ? '!' : '✓'} jobs      ${jobs.join(', ')}${dry ? ' (plan):' : ':'}`)
        for (const l of `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n')) if (l.trim()) line(`   ${l}`)
      }
    }

    // --- 10. verify ------------------------------------------------------------------
    const match = !serverInfo?.version || serverInfo.version === VERSION
    line(
      `${match ? '✓' : '!'} croft ${VERSION} ${match ? '↔' : '≠'} server ${serverInfo?.version ?? '?'}` +
        ' — restart your agent sessions to load the hooks',
    )
  },

  async map() {
    const dir = flags.dir ?? gitRoot(process.cwd()) ?? process.cwd()
    const key = positional[0]

    if (!key) {
      const map = readProjectMap()
      const rows = Object.entries(map).map(([path, k]) => ({ project: k, path }))
      emit(
        { count: rows.length, here: projectForDir(process.cwd()) ?? '', rows },
        { rows: (d) => d.rows, columns: ['project', 'path'] },
      )
      await warnRetiredMappings(map)
      return
    }

    const map = readProjectMap()
    const repo = gitRemote(dir)
    let claimed = null

    if (key === 'none') {
      // Releasing the repository claim too, because `map <KEY>` made one.
      // Deleting only the local line left every clone of this repository —
      // including this one — still resolving, so `map none` reported success
      // and changed nothing observable: the silent failure this command was
      // just taught to stop producing.
      //
      // The claim belongs to a project, so we need the one that holds it: the
      // local line if there is one, and otherwise whatever the repository
      // itself currently resolves to, which is the case a fresh clone hits.
      const holder =
        map[dir] ??
        (repo
          ? (await request('GET', `/api/v1/context?repo=${encodeURIComponent(repo)}`, undefined, {
              soft: true,
            }))?.project
          : null)

      delete map[dir]

      if (repo && holder) {
        const released = await request(
          'DELETE',
          `/api/v1/projects/${holder}/repos?remote=${encodeURIComponent(repo)}`,
          undefined,
          { soft: true },
        )
        if (released) claimed = { released: repo, from: holder }
      }
    } else {
      // This used to write whatever it was handed. A mistyped key produced a
      // map that resolved to nothing, silently, for as long as it took someone
      // to wonder why the briefing had gone quiet.
      //
      // Store the key the server came back with rather than the spelling we
      // were given: this route resolves a uuid too, and a uuid in the map is 36
      // characters that every later /context rejects outright — which is the
      // same silence, reached by a route that looks like it validated.
      // A retired key resolves to the live project, and the request above has
      // already said so on stderr. What is stored is the LIVE key, so this
      // checkout stops sending the old one.
      const project = await request('GET', `/api/v1/projects/${encodeURIComponent(key)}`)
      map[dir] = project.key

      // Claim the repository too, so a second clone, a moved directory and a
      // worktree all resolve without being mapped again. Soft: an older server
      // has no such route, and that is no reason to refuse the local mapping.
      if (repo) {
        const linked = await request(
          'POST',
          `/api/v1/projects/${project.key}/repos`,
          { remote: repo, rootCommit: gitRootCommit(dir) },
          { soft: true },
        )
        if (linked) claimed = { linked: repo, to: project.key }
      }
    }

    mkdirSync(dirname(PROJECT_MAP_PATH), { recursive: true })
    writeFileSync(PROJECT_MAP_PATH, `${JSON.stringify(map, null, 2)}\n`)
    emit({ path: dir, project: map[dir] ?? null, repo, ...(claimed ?? {}) })
  },

  async reconcile() {
    const body = { dryRun: Boolean(flags['dry-run']) }
    if (flags.older) body.olderThanMinutes = Number(flags.older)
    const data = await request('POST', '/api/v1/reconcile', body)
    emit(
      { count: data.released.length, ...data },
      {
        rows: (d) =>
          d.released.map((r) => ({
            ref: r.ref,
            holder: r.holder ?? '',
            held: `${r.heldForMinutes}m`,
            checkpoint: r.hadCheckpoint ? 'yes' : 'none',
          })),
        columns: ['ref', 'holder', 'held', 'checkpoint'],
      },
    )
  },
}

let command = positional.shift()

if (flags.version || command === 'version') {
  // Asks the server too, and says when they disagree. A stale copy is
  // invisible otherwise: it goes on working, just not the way the docs say.
  // The comparison is the one every other request makes, through the same
  // function, so it is said once and only once.
  let server = null
  let res = null
  // The same refusal every other command gives, as a warning: the local
  // version is still worth answering with when the configuration is not.
  if (INSTANCE_REFUSAL) process.stderr.write(`${INSTANCE_REFUSAL.message}\n`)
  try {
    if (BASE && !INSTANCE_REFUSAL) {
      res = await fetch(`${BASE}/api/v1/health`)
      server = (await res.json())?.data ?? null
    }
  } catch {
    // Offline, or not pointed at a server yet. The local version still answers.
  }
  const mine = fingerprint()
  process.stdout.write(`croft ${VERSION}${mine ? ` ${mine}` : ''}\n`)
  if (server) {
    process.stdout.write(`server ${server.version ?? '?'} (${server.build ?? '?'}) ${BASE}${INSTANCE.name ? ` [instance ${INSTANCE.name}]` : ''}\n`)
    warnIfStale(res)
  }
  process.exit(0)
}

if (!command || flags.help || command === 'help') {
  process.stdout.write(HELP)
  process.exit(0)
}
if (!commands[command]) {
  die(`unknown command "${command}"\n\nvalid: ${Object.keys(commands).sort().join(' ')}`)
}

/**
 * S-12 is a subject, and a subject is not a task: its routes are /subjects.
 * `show`, `note`, `attach` and `files` mean the same thing for both, so they go where the ref
 * says; any other task verb is told which verbs a subject takes.
 */
const TASK_VERBS = new Set([
  'claim', 'beat', 'release', 'checkpoint', 'block', 'unblock', 'log', 'comment', 'done',
  'cancel', 'update', 'commit', 'push', 'run', 'attach', 'files', 'children', 'history', 'deps',
  'blockedby', 'unblockedby',
])
if (/^[Ss]-\d+$/.test(positional[0] ?? '')) {
  if (command === 'show' || command === 'note' || command === 'attach' || command === 'files') {
    positional.unshift(command)
    command = 'subject'
  } else if (TASK_VERBS.has(command)) {
    const ref = positional[0].toUpperCase()
    die(`${ref} is a subject, not a todo — subjects take: croft subject show|edit|stage|note|notes|attach|files|tag|todo ${ref}`)
  }
}

/**
 * `reconcile` and `sync` are about an instance, not a directory, and they
 * run from a scheduler whose directory is `/`. On a machine with several
 * instances, routing would send them to the default or nowhere, so a
 * scheduled job says --all-instances and gets one run per instance, each
 * under that instance's own key. With one instance it changes nothing.
 */
const FANS_OUT = new Set(['reconcile', 'sync'])

if (flags['all-instances']) {
  if (!FANS_OUT.has(command)) {
    die(`--all-instances is for ${[...FANS_OUT].join(' and ')}, the commands about an instance rather than a directory`)
  }
  if (flags.instance) die('--all-instances and --instance contradict each other; give one')
  if (INSTANCES && !INSTANCES.error) {
    const names = Object.keys(INSTANCES.instances)
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CROFT_API_KEY', 'CROFT_BASE_URL', 'CROFT_INSTANCE'].includes(k)))
        const passthrough = []
    const argv = process.argv.slice(2)
    for (let i = 0; i < argv.length; i += 1) {
      const [flag] = argv[i].split('=')
      if (['--all-instances', '--instance'].includes(flag)) {
        if (flag !== '--all-instances' && !argv[i].includes('=') && argv[i + 1] && !argv[i + 1].startsWith('--')) i += 1
        continue
      }
      passthrough.push(argv[i])
    }
    // JSON is one document keyed by instance, so a caller can still parse it;
    // the table form reads as one section per instance.
    const structured = FORMAT !== 'tsv'
    const results = {}
    let failed = 0
    for (const name of names) {
      if (!structured) process.stdout.write(`== instance ${name} ==\n`)
      const result = spawnSync(
        process.execPath,
        [process.argv[1], ...passthrough, '--instance', name],
        { env, stdio: ['ignore', structured ? 'pipe' : 'inherit', 'inherit'], encoding: 'utf8', timeout: 5 * 60_000 },
      )
      if (structured) {
        try { results[name] = JSON.parse(result.stdout) } catch { results[name] = { error: `exit ${result.status ?? result.signal}` } }
      }
      if (result.status !== 0) {
        failed += 1
        process.stderr.write(`croft: ${command} on instance ${name} failed (exit ${result.status ?? result.signal})\n`)
      }
    }
    if (structured) console.log(JSON.stringify({ instances: results }, null, 2))
    process.exit(failed ? 1 : 0)
  }
}
await commands[command]()

/**
 * Anything the caller typed that the command never looked at.
 *
 * `--json` and `--pretty` are read at module load, `--help` and `--version`
 * exit before this line, so the only thing left here is a flag that belongs to
 * a different verb, or to no verb at all — and in either case the caller
 * believes it took effect.
 *
 * Read verbs exit 2, because the answer looks filtered and is not and nothing
 * has happened yet. Write verbs do not: the write already went through, and an
 * exit code that says otherwise is how a caller ends up making it twice.
 */
const ignored = Object.keys(typedFlags).filter((flag) => !readFlags.has(flag))
if (ignored.length > 0) {
  const list = ignored.map((flag) => `--${flag}`).join(', ')
  process.stderr.write(
    `croft: \`${command}\` does not take ${list} — ` +
      `it was accepted by the parser and then read by nothing.\n` +
      (mutated || wroteLocally
        ? `The write went through WITHOUT it; re-run with the right flag if that was not what you meant.\n`
        : `Refused rather than answered: a filter that is dropped returns an answer that looks filtered and is not.\n`),
  )
  if (!mutated && !wroteLocally) process.exit(2)
}

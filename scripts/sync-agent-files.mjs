#!/usr/bin/env node
/**
 * One copy of each agent-facing file, everywhere it has to live.
 *
 * The skill, the CLI and the two hooks are read from a directory per runtime,
 * so the same file exists four, five, six times across a laptop and a server.
 * They drift silently, and the drift is invisible until an agent behaves
 * differently from its siblings for reasons nobody can see. Both halves of
 * that bit in one day: a skill copy a day out of date, and a CLI three days
 * old that was still writing under the wrong identity — the very bug the day
 * had been spent fixing.
 *
 *   node scripts/sync-agent-files.mjs --check   # report drift, write nothing
 *   node scripts/sync-agent-files.mjs           # make every reachable copy match
 *   node sync-agent-files.mjs --source https://raw.githubusercontent.com/montytorr/croft/v0.3.0
 *
 * Targets that do not apply to this machine are skipped, not invented: a file
 * in a directory no runtime reads is worse than no file at all. The built-in
 * targets are this user's own; anything else — another user's home, a runtime
 * with a tree of its own — is named by `--also`, because which copies exist is
 * a fact about a machine rather than about Croft.
 *
 * What this writes is code every agent session on the machine then runs, with
 * that user's rights, so where it comes from is the whole security question.
 * A scheduled run syncs from the tag of the release `croft setup` installed,
 * never from a branch any push can move; it fetches every file before writing
 * any; and it never replaces itself from the network. See `resolveSource`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

const home = homedir()

/** A target applies only if the directory its runtime reads already exists. */
const at = (path, needs) => ({ path, needs: needs ?? dirname(path) })

const ARTEFACTS = [
  {
    name: 'skill',
    file: 'skills/croft/SKILL.md',
    mode: 0o644,
    targets: [
      at(join(home, '.claude/skills/croft/SKILL.md'), join(home, '.claude')),
      at(join(home, '.codex/skills/croft/SKILL.md'), join(home, '.codex')),
    ],
  },
  {
    name: 'cli',
    file: 'cli/croft.mjs',
    mode: 0o755,
    // `needs` is the file itself: update a CLI where one is already installed,
    // never put a second one somewhere nobody asked for. /usr/local/bin exists
    // on every machine; that is not consent to install into it.
    targets: [
      at(join(home, '.local/bin/croft'), join(home, '.local/bin/croft')),
      at('/usr/local/bin/croft', '/usr/local/bin/croft'),
    ],
  },
  {
    // The repairer, which was the one file it never repaired. It is copied out
    // of the checkout to a stable path so a scheduled job does not depend on a
    // working tree that can be moved or checked out to a branch, and that copy
    // then goes stale exactly like every other copy here did.
    //
    // `self`: never replaced from a remote source — see REMOTE below.
    name: 'maintenance',
    file: 'scripts/sync-agent-files.mjs',
    mode: 0o755,
    self: true,
    targets: [
      at('/opt/croft-maintenance/sync-agent-files.mjs', '/opt/croft-maintenance/sync-agent-files.mjs'),
      at(
        join(home, '.croft/maintenance/sync-agent-files.mjs'),
        join(home, '.croft/maintenance/sync-agent-files.mjs'),
      ),
    ],
  },
  {
    /**
     * The MCP facade, which drifts for the same reason everything else here
     * does and was missed because it arrives by an installer rather than a
     * copy.
     *
     * It shipped at 19 tools, gained a twentieth the same day, and the
     * installed copy stayed at 19 — a runtime reading a facade a version
     * behind the CLI it is a facade OF, which is the exact failure this file
     * exists to prevent.
     *
     * Only `server.mjs`: the node_modules beside it is the installer's job and
     * changes only when the dependency does. `needs` is the file itself, so
     * this repairs an install and never creates one.
     */
    name: 'mcp',
    file: 'mcp/server.mjs',
    mode: 0o644,
    targets: [at('/opt/croft-mcp/server.mjs', '/opt/croft-mcp/server.mjs')],
  },
  {
    // And the installer beside it, for the same reason and by the same
    // argument. It was left out when the entry above was written, so it became
    // the one deployed copy that drifted -- while every other copy on that host
    // stayed identical, which is precisely the state that makes drift look
    // impossible. A file is only kept honest here if it is listed here.
    name: 'maintenance:cron',
    file: 'scripts/install-cron.mjs',
    mode: 0o755,
    self: true,
    targets: [
      at('/opt/croft-maintenance/install-cron.mjs', '/opt/croft-maintenance/install-cron.mjs'),
      at(
        join(home, '.croft/maintenance/install-cron.mjs'),
        join(home, '.croft/maintenance/install-cron.mjs'),
      ),
    ],
  },
  {
    name: 'hook:context',
    file: 'hooks/croft-context.mjs',
    mode: 0o755,
    targets: [
      at(join(home, '.croft/hooks/croft-context.mjs')),
    ],
  },
  /**
   * OpenClaw's bootstrap hook, which install-hooks.mjs copies here and links
   * with `openclaw hooks install --link`. A linked directory is read in place,
   * so keeping this copy current is the whole upgrade — bar a gateway restart,
   * which is OpenClaw's to do. `needs` is the hook's own directory: repaired
   * where it was installed, never created. `--also hook:openclaw-briefing=…`
   * (and `hook:openclaw-briefing-doc=…`) reaches a gateway run as another user.
   */
  {
    name: 'hook:openclaw-briefing',
    file: 'hooks/openclaw/croft-briefing/handler.ts',
    mode: 0o644,
    targets: [at(join(home, '.croft/hooks/openclaw/croft-briefing/handler.ts'))],
  },
  {
    name: 'hook:openclaw-briefing-doc',
    file: 'hooks/openclaw/croft-briefing/HOOK.md',
    mode: 0o644,
    targets: [at(join(home, '.croft/hooks/openclaw/croft-briefing/HOOK.md'))],
  },
]

/**
 * Copies outside this user's home, for a scheduled run that has to reach them.
 * `--also <artefact>=<path>`, repeatable. A machine's own layout belongs in the
 * job that runs this, not in a public repository.
 *
 * This is how every non-standard location is reached, and there are two common
 * ones: another user's home, when the job runs as root and the runtimes do not;
 * and a runtime that keeps its skills in a tree of its own rather than a
 * dotfile directory, which is the usual shape for a gateway-style runtime.
 * `CROFT_SYNC_ALSO` on `install-cron.mjs` renders these into the scheduled job.
 */
for (let i = 0; i < process.argv.length; i += 1) {
  if (process.argv[i] !== '--also') continue
  const [name, path] = (process.argv[i + 1] ?? '').split('=')
  const artefact = ARTEFACTS.find((a) => a.name === name)
  if (artefact && path) artefact.targets.push(at(path))
}

const CHECK = process.argv.includes('--check')
const NOTIFY = arg('--notify')
/**
 * `personal:CROFT-107` on a machine with several Croft instances: the task is
 * on one of them, and a scheduled job has no directory to route by.
 */
const [NOTIFY_INSTANCE, NOTIFY_REF] = NOTIFY?.includes(':')
  ? [NOTIFY.slice(0, NOTIFY.indexOf(':')), NOTIFY.slice(NOTIFY.indexOf(':') + 1)]
  : [null, NOTIFY]
const SEVERAL_INSTANCES = existsSync(join(home, '.croft', 'instances.json'))
const ENV_FILE = NOTIFY_INSTANCE ? join(home, '.croft', 'instances', NOTIFY_INSTANCE, 'env') : join(home, '.croft/env')

/**
 * Said on every run, not only on the run that has something to report: a
 * missing key found only when a repair happens is found once a week, in the
 * one log line nobody is reading that day. Mirrors the CLI's rule — a split
 * ~/.croft/env with no key for this identity means the report would be filed
 * as someone else, so the CLI refuses it.
 */
const identityProblem = () => {
  const agent = (process.env.CROFT_AGENT ?? '').trim().toLowerCase()
  if (!NOTIFY || agent !== 'maintenance' || process.env.CROFT_API_KEY) return null
  if (SEVERAL_INSTANCES && !NOTIFY_INSTANCE) {
    return `WARNING: this machine has several Croft instances (~/.croft/instances.json) and --notify ${NOTIFY} ` +
      `does not say which one ${NOTIFY} is on. Write it as <instance>:${NOTIFY}.`
  }
  let names = []
  try {
    names = readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim().split('=')[0]?.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  const split = names.some((name) => name.startsWith('CROFT_API_KEY_'))
  if (!split || names.includes('CROFT_API_KEY_MAINTENANCE')) return null
  return (
    `WARNING: CROFT_AGENT=maintenance but ${ENV_FILE} has no CROFT_API_KEY_MAINTENANCE. ` +
    `Reports to ${NOTIFY} will be refused rather than filed under another runtime's key.`
  )
}
const IDENTITY_PROBLEM = identityProblem()
if (IDENTITY_PROBLEM) {
  console.log(IDENTITY_PROBLEM)
  process.exitCode = 1
}
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16)

/**
 * A laptop wakes before its network does.
 *
 * launchd runs a missed calendar slot the moment the machine wakes, which is
 * exactly when DNS is not up yet: the Mac's log had 20 ENOTFOUND and 22
 * "fetch failed" runs, each one another hour on a stale CLI (CROFT-290). So a
 * network error is retried for about a minute and a half before it counts. An
 * HTTP error is an answer, not an outage, and is not retried.
 */
const RETRY_DELAYS_MS = (process.env.CROFT_SYNC_RETRY_MS ?? '5000,15000,30000,45000')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n >= 0)

const fetchWithRetry = async (url) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Bounded per attempt: a server that accepts the connection and never
      // answers would otherwise hold a scheduled run open until the next one.
      return await fetch(url, { signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) throw error
      const why = error.cause?.code ?? error.message
      console.log(`  (network: ${why}; retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s)`)
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
}

/**
 * The run stops here, before a single file is touched, and says why.
 *
 * Every way of not knowing what to install ends in this one place, and none of
 * them falls back to anything: a sync that cannot say which release it should
 * be installing and installs *something* anyway is the failure this guards
 * against. Exit 1, so launchd, cron and `--run` all see a job that did not do
 * its work — the copies stay as they were, which is stale at worst.
 */
const refuse = (why) => {
  console.log(`\nNOT SYNCED: ${why}`)
  console.log('Nothing was written. The copies on this machine are unchanged.')
  process.exit(1)
}

const DEFAULT_REPO = 'https://raw.githubusercontent.com/montytorr/croft'

/**
 * The URL every scheduled job was rendered with before jobs were pinned.
 *
 * A job keeps its command line until `croft setup` runs again, but the script
 * that command names was replaced by the very sync it ran — so the first run
 * of this file on such a machine is the one chance to stop following `main`
 * without waiting for anybody to re-run anything. It is read as the installed
 * release. Following a branch is still possible, on purpose: CROFT_RAW_BASE on
 * the installer renders `--unpinned` beside it, and nothing else does.
 */
const LEGACY_MAIN = `${DEFAULT_REPO}/main`
const UNPINNED = process.argv.includes('--unpinned')

/**
 * A release number as package.json spells it, and nothing else: it becomes a
 * path segment in a URL whose answer is executed, so `main`, `../x`,
 * `1.2.3/../../evil` or an empty string must never get there.
 */
const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/

/**
 * https only, bar loopback. What comes back from a remote source is run by
 * every agent session on the machine, so a plain-http base would hand that to
 * anyone on the path between the two.
 */
const remoteBase = (label, given) => {
  const trimmed = given.replace(/\/+$/, '')
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return refuse(`${label} ${given} is not a URL`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return refuse(`${label} ${given} is not https — these files are code, and are not fetched in the clear`)
  }
  if (url.search || url.hash || url.username || url.password) {
    return refuse(`${label} ${given} carries a query, fragment or credentials; give the bare base URL`)
  }
  if (trimmed.split('/').some((segment) => segment === '..' || segment === '.')) {
    return refuse(`${label} ${given} has a . or .. segment`)
  }
  return trimmed
}

/**
 * The release installed here: the version the CLI on this machine carries.
 * That is the copy `croft setup` wrote from the release it unpacked, and the
 * one a legacy job has been keeping in step with ever since.
 */
const installedRelease = () => {
  const cli = ARTEFACTS.find((artefact) => artefact.name === 'cli')
  for (const { path } of cli.targets) {
    try {
      const version = readFileSync(path, 'utf8').match(/^const VERSION = '([^']*)'/m)?.[1]
      if (version !== undefined) {
        return RELEASE.test(version)
          ? version
          : refuse(`${path} says it is version ${JSON.stringify(version)}, which is not a release number`)
      }
    } catch {
      // not installed at this path
    }
  }
  return refuse('no installed croft CLI to read the release from. Run `croft setup` to install and pin one.')
}

/**
 * Where the canonical files come from, and whether that is the network.
 *
 *   (no --source)                 the checkout this script sits in
 *   --source <dir>                a checkout or a deploy's tree, on disk
 *   --source <base>/v<release>    that tag — what `croft setup` schedules
 *   --source <url> --unpinned     exactly that base; a branch, on purpose
 *
 * A remote source that is not a release tag is refused unless --unpinned says
 * a branch is meant: following `main` is a decision, not a default. The tags
 * of the pre-pinning URL come from CROFT_RAW_REPO when it is set (a mirror only
 * has to serve the same paths under `v<version>/`).
 */
const resolveSource = () => {
  const given = arg('--source')
  if (given === null) return join(HERE, '..')
  if (!/^[a-z][a-z0-9+.-]*:/i.test(given)) {
    if (!given) refuse('--source is empty')
    return given
  }
  if (given.replace(/\/+$/, '') === LEGACY_MAIN && !UNPINNED) {
    const version = installedRelease()
    const repo = remoteBase('CROFT_RAW_REPO', process.env.CROFT_RAW_REPO || DEFAULT_REPO)
    console.log(`--source ${LEGACY_MAIN} is the pre-pinning default; pinning to the installed release instead`)
    console.log(`release   v${version}`)
    return `${repo}/v${version}`
  }
  const base = remoteBase('--source', given)
  if (UNPINNED) {
    console.log(`unpinned  follows ${base} as it moves (--unpinned)`)
    return base
  }
  const tag = base.slice(base.lastIndexOf('/') + 1)
  if (!tag.startsWith('v') || !RELEASE.test(tag.slice(1))) {
    return refuse(
      `--source ${given} does not end in a release tag (v<major>.<minor>.<patch>). ` +
        'A branch is followed only with --unpinned (CROFT_RAW_BASE on install-cron.mjs).',
    )
  }
  console.log(`release   ${tag}`)
  return base
}

const SOURCE = resolveSource()

/**
 * The network is not trusted with the repairer itself.
 *
 * A script that rewrites its own code from a URL on a timer cannot be audited
 * once it is installed: whatever was reviewed is gone by the next slot. So from
 * a remote source the two maintenance scripts are never written — they change
 * when `croft setup` runs, which places them from the release it unpacked, or
 * when the source is a tree on disk (a checkout, or the deploy's own tree),
 * which somebody put there on purpose.
 */
const REMOTE = /^https?:\/\//.test(SOURCE)
console.log(`source    ${SOURCE}`)

const readSource = async (file) => {
  if (!REMOTE) return readFileSync(join(SOURCE, file))
  const response = await fetchWithRetry(`${SOURCE}/${file}`)
  if (!response.ok) throw new Error(`${file} returned ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Every file is read before any is written. One that cannot be fetched — a tag
 * a mirror never got, a CDN hiccup halfway down the list — used to throw after
 * the files before it had been replaced, leaving a machine on two releases at
 * once. Now it is all of them or none.
 */
const sources = new Map()
for (const artefact of ARTEFACTS) {
  if (REMOTE && artefact.self) continue
  try {
    sources.set(artefact.name, await readSource(artefact.file))
  } catch (error) {
    refuse(`could not read ${artefact.file} from ${SOURCE} (${error.cause?.code ?? error.code ?? error.message})`)
  }
}

const repaired = []
let drifted = 0

for (const artefact of ARTEFACTS) {
  if (!sources.has(artefact.name)) {
    console.log(`\n${artefact.name}  ${artefact.file}`)
    console.log('  skipped   (updated by `croft setup`, never from a remote source)')
    continue
  }
  const source = sources.get(artefact.name)
  const canonical = hash(source)
  console.log(`\n${artefact.name}  ${canonical}  ${artefact.file}`)

  // A `--also` path can name a file a built-in target already covers — the
  // same file reported twice, the second time as already fine, which reads
  // like a copy that was never touched.
  const unique = artefact.targets.filter(
    (t, i) => artefact.targets.findIndex((o) => o.path === t.path) === i,
  )

  for (const target of unique) {
    if (!existsSync(target.needs)) {
      console.log(`  skipped   ${target.path}  (no ${target.needs} here)`)
      continue
    }

    const present = existsSync(target.path)
    const current = present ? hash(readFileSync(target.path)) : null
    if (current === canonical) {
      console.log(`  ok        ${target.path}`)
      continue
    }

    drifted += 1
    const state = present ? current : 'missing'
    if (CHECK) {
      console.log(`  DRIFT     ${target.path}  (${state})`)
      continue
    }

    try {
      mkdirSync(dirname(target.path), { recursive: true })
      writeFileSync(target.path, source)
      chmodSync(target.path, artefact.mode)
      // Run as root, a file this creates in someone's home would be root's,
      // and that person's own installer could no longer replace it. A file
      // that existed keeps its owner; a new one takes its directory's.
      if (!present && process.getuid?.() === 0) {
        const { uid, gid } = statSync(dirname(target.path))
        chownSync(target.path, uid, gid)
      }
      repaired.push(`${artefact.name}: ${target.path} (was ${state})`)
      console.log(`  updated   ${target.path}  ${state} -> ${canonical}`)
    } catch (error) {
      console.log(`  FAILED    ${target.path}  (${error.code ?? error.message})`)
    }
  }
}

/**
 * Silence when nothing moved, a record when something did. A scheduled repair
 * that never says anything is indistinguishable from one that is not running,
 * and one that reports every hour trains everybody to ignore it.
 */
if (NOTIFY && repaired.length > 0) {
  const note =
    `Agent files repaired on ${process.env.HOSTNAME ?? 'this host'} ` +
    `(${repaired.length} cop${repaired.length === 1 ? 'y' : 'ies'}):\n` +
    repaired.map((line) => `  ${line}`).join('\n') +
    `\n\nEach was being read by a runtime in that state until now.`
  // stderr is kept, not thrown away. It is where the CLI says whose key it is
  // using, and discarding it hid for weeks that a scheduled job with
  // CROFT_AGENT=maintenance and no maintenance key was filing its reports as
  // another runtime (CROFT-290). The CLI now refuses that outright; this is
  // what makes the refusal reach the log, and the exit code the scheduler.
  const said = (text) =>
    String(text ?? '')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => `  croft: ${line.replace(/^croft: /, '')}`)
  try {
    const stderr = execFileSync('croft', ['note', NOTIFY_REF, note, '--kind', 'note', ...(NOTIFY_INSTANCE ? ['--instance', NOTIFY_INSTANCE] : [])], {
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    })
    console.log(`\nreported to ${NOTIFY}`)
    for (const line of said(stderr)) console.log(line)
  } catch (error) {
    console.log(`\nCOULD NOT REPORT to ${NOTIFY} (exit ${error.status ?? error.code ?? '?'})`)
    for (const line of said(error.stderr)) console.log(line)
    process.exitCode = 1
  }
}

if (CHECK && drifted > 0) {
  console.log(`\n${drifted} cop${drifted === 1 ? 'y is' : 'ies are'} out of date — run without --check`)
  process.exit(1)
}

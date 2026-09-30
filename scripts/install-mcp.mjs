#!/usr/bin/env node
/**
 * Install the MCP facade somewhere every runtime on the box can actually run it.
 *
 *   node scripts/install-mcp.mjs              # print what would happen, change nothing
 *   sudo -E node scripts/install-mcp.mjs --install
 *   sudo node scripts/install-mcp.mjs --remove
 *
 * Printing is the default, for the same reason it is in the other installers
 * here: a script that writes into /opt and /usr/local/bin the moment it runs is
 * a script nobody should run.
 *
 * This is OPTIONAL. The CLI is the implementation and every interface shells
 * out to it; MCP buys per-tool timeouts and approval modes in Codex, enforced
 * tool schemas in Claude Code, and a way in for a runtime that speaks nothing
 * else. An agent that can run a shell command needs none of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT A LINE IN THE README
 * ---------------------------------------------------------------------------
 * The facade is not a single file. Unlike the CLI, which is dependency-free on
 * purpose so it can be copied onto a box and run, this one imports the MCP SDK
 * and therefore needs a node_modules beside it. So it cannot be a sync target
 * like the skill and the hooks are, and "point a wrapper at a checkout" is what
 * gets reached for instead.
 *
 * On this project that wrapper pointed into a checkout under /root on a machine
 * where the runtime registering the server does not run as root. The directory
 * is 0700, so `croft-mcp` answered MODULE_NOT_FOUND and the registered server
 * simply never started — for a runtime whose config named it correctly, from a
 * file that looked right in every listing. The checkout was also a second one
 * nothing kept up to date, so where it did resolve it served older code.
 *
 * Hence: a real install directory, a wrapper that names it, and a check that
 * the account the runtimes use can traverse and read what was installed. That
 * last part is the whole point — an MCP server that cannot start looks exactly
 * like one that is not registered.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, '..', 'mcp')

const env = (name, fallback) => process.env[name] ?? fallback

/** Where the facade and its node_modules live. */
const DIR = resolve(env('CROFT_MCP_DIR', '/opt/croft-mcp'))
/** The name runtimes are configured with, which must be on PATH. */
const BIN = resolve(env('CROFT_MCP_BIN', '/usr/local/bin/croft-mcp'))
/** The CLI the facade shells out to, if it is not simply `croft` on PATH. */
const CROFT_BIN = env('CROFT_BIN', '')

const INSTALL = process.argv.includes('--install')
const REMOVE = process.argv.includes('--remove')

const MANAGED = '# Managed by scripts/install-mcp.mjs — edits will be overwritten.'

const wrapper = () => `#!/bin/sh
${MANAGED}
${CROFT_BIN ? `CROFT_BIN=${CROFT_BIN}\nexport CROFT_BIN\n` : ''}exec node ${join(DIR, 'server.mjs')} "$@"
`

/**
 * Every directory on the way in has to be traversable, and the file readable,
 * by an account that is not the one installing. This is the check that would
 * have caught the original: a wrapper under a 0700 home is invisible to the
 * runtime that names it, and says so only as MODULE_NOT_FOUND at startup.
 */
const unreachable = () => {
  const bad = []
  const parts = DIR.split('/').filter(Boolean)
  let path = ''
  for (const part of parts) {
    path += `/${part}`
    try {
      const mode = statSync(path).mode
      // o+x on a directory is what lets another account walk through it.
      if ((mode & 0o001) === 0) bad.push(`${path} is not traversable by other accounts`)
    } catch {
      bad.push(`${path} does not exist`)
    }
  }
  const server = join(DIR, 'server.mjs')
  if (existsSync(server) && (statSync(server).mode & 0o004) === 0) {
    bad.push(`${server} is not readable by other accounts`)
  }
  return bad
}

const requireRoot = (action) => {
  if (process.getuid?.() === 0) return
  try {
    accessSync(dirname(BIN), constants.W_OK)
    accessSync(dirname(DIR), constants.W_OK)
  } catch {
    console.error(`--${action} writes to ${DIR} and ${BIN}, which need root here.\n`)
    console.error(`  sudo -E node scripts/install-mcp.mjs --${action}\n`)
    console.error('-E keeps CROFT_MCP_DIR, CROFT_MCP_BIN and CROFT_BIN, which sudo drops.')
    process.exit(1)
  }
}

if (REMOVE) {
  requireRoot('remove')
  rmSync(BIN, { force: true })
  rmSync(DIR, { recursive: true, force: true })
  console.log(`removed ${BIN}\nremoved ${DIR}`)
  process.exit(0)
}

if (!INSTALL) {
  console.log(`would install the facade into ${DIR}`)
  console.log(`  ${join(SOURCE, 'server.mjs')} -> ${join(DIR, 'server.mjs')}`)
  console.log(`  ${join(SOURCE, 'package.json')} -> ${join(DIR, 'package.json')}`)
  console.log(`  npm install --omit=dev, in ${DIR}`)
  console.log(`\nwould write ${BIN}:\n`)
  console.log(wrapper())
  console.log('then register it with the runtimes that want native tools:\n')
  console.log('  claude mcp add croft -- croft-mcp          # Claude Code')
  console.log('  # Codex, in ~/.codex/config.toml:')
  console.log('  #   [mcp_servers.croft]')
  console.log('  #   command = "croft-mcp"')
  console.log('  #   startup_timeout_sec = 10')
  console.log('  #   tool_timeout_sec = 60')
  console.log('\nnothing was changed. --install to do it.')
  process.exit(0)
}

requireRoot('install')

if (!existsSync(join(SOURCE, 'server.mjs'))) {
  console.error(`no facade at ${SOURCE} — run this from a checkout.`)
  process.exit(1)
}

mkdirSync(DIR, { recursive: true, mode: 0o755 })
cpSync(join(SOURCE, 'server.mjs'), join(DIR, 'server.mjs'))
cpSync(join(SOURCE, 'package.json'), join(DIR, 'package.json'))
chmodSync(join(DIR, 'server.mjs'), 0o644)
chmodSync(join(DIR, 'package.json'), 0o644)
console.log(`installed the facade into ${DIR}`)

try {
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: DIR,
    stdio: 'inherit',
  })
} catch {
  console.error(`\nnpm install failed in ${DIR}. The facade needs the MCP SDK to start.`)
  process.exit(1)
}

writeFileSync(BIN, wrapper(), { mode: 0o755 })
chmodSync(BIN, 0o755)
console.log(`wrote ${BIN}`)

/**
 * Say it plainly rather than leaving it to a runtime to discover at startup.
 * A registered server that cannot start is indistinguishable, from inside the
 * agent, from one that was never registered.
 */
const bad = unreachable()
if (bad.length > 0) {
  console.error('\nINSTALLED, BUT NOT REACHABLE BY OTHER ACCOUNTS:')
  for (const line of bad) console.error(`  ${line}`)
  console.error(
    '\nA runtime running as another user will get MODULE_NOT_FOUND and the\n' +
      'server will never start. Set CROFT_MCP_DIR somewhere world-readable,\n' +
      'or open up the path above.',
  )
  process.exit(1)
}

console.log('\nreachable by other accounts. Register it:')
console.log('  claude mcp add croft -- croft-mcp')
console.log('  # Codex: [mcp_servers.croft] command = "croft-mcp"')

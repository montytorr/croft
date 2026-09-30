import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * The agent-files job overwrites the CLI, the session hook and the skill every
 * fifteen minutes, with the user's rights. What is pinned here is the contract
 * that makes that safe:
 *
 * - a remote source is a release tag, or is followed on purpose (--unpinned);
 * - the URL every job was rendered with before pinning (`…/croft/main`) is read
 *   as the release installed here, so old jobs stop following main unaided;
 * - one file that cannot be fetched means nothing is written, and exit 1;
 * - from a remote source the job never rewrites its own two scripts;
 * - only https (or loopback) bases, and a fork named as <owner>/<name>.
 *
 * Every write goes to a temporary HOME. The sync also has a few targets outside
 * any home (/usr/local/bin/croft, /opt/croft-*), which it only ever updates
 * where they already exist; the cases that let it write are skipped on a
 * machine that has any of them, rather than risk replacing a real install with
 * test content.
 */

const REPO = process.cwd()
const NODE_DIR = dirname(process.execPath)
const BASE_PATH = `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`
const SYSTEM_TARGETS = [
  '/usr/local/bin/croft',
  '/opt/croft-maintenance/sync-agent-files.mjs',
  '/opt/croft-maintenance/install-cron.mjs',
  '/opt/croft-mcp/server.mjs',
].some((path) => existsSync(path))

const temporaryDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const temp = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const run = (command: string, args: string[], env: Record<string, string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

/**
 * A raw mirror: /raw/<ref>/<file> serves a marker naming the URL, so a copy on
 * disk says exactly where it came from. `missing` files answer 404.
 */
const serve = (missing: string[] = []) =>
  new Promise<{ base: string; raw: string; requests: string[] }>((resolve) => {
    const requests: string[] = []
    const server = createServer((req, res) => {
      const path = req.url ?? ''
      requests.push(path)
      const file = /^\/raw\/[^/]+\/(.+)$/.exec(path)?.[1]
      if (file && !missing.includes(file)) {
        res.writeHead(200)
        return res.end(`served:${path}`)
      }
      res.writeHead(404)
      res.end('not found')
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve({ base, raw: `${base}/raw`, requests })
    })
  })

const LEGACY_MAIN = 'https://raw.githubusercontent.com/montytorr/croft/main'

/** A laptop with Claude Code, a CLI of a given release, the hook dir, and both maintenance copies. */
const machine = async (cliVersion: string | null = '1.2.3') => {
  const home = await temp('croft-pin-home-')
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(join(home, '.local/bin'), { recursive: true })
  await mkdir(join(home, '.croft/hooks'), { recursive: true })
  await mkdir(join(home, '.croft/maintenance'), { recursive: true })
  const cli = cliVersion === null ? 'old cli\n' : `#!/usr/bin/env node\nconst VERSION = '${cliVersion}'\n`
  await writeFile(join(home, '.local/bin/croft'), cli)
  await writeFile(join(home, '.croft/maintenance/sync-agent-files.mjs'), 'old sync')
  await writeFile(join(home, '.croft/maintenance/install-cron.mjs'), 'old installer')
  return { home, cli }
}

const sync = (home: string, args: string[], extra: Record<string, string> = {}) =>
  run(process.execPath, ['scripts/sync-agent-files.mjs', ...args], {
    PATH: BASE_PATH,
    HOME: home,
    CROFT_SYNC_RETRY_MS: '0',
    ...extra,
  })

describe.skipIf(SYSTEM_TARGETS)('sync-agent-files from a release tag', () => {
  it('syncs exactly the tag it is given, and nothing from a branch', async () => {
    const { raw, requests } = await serve()
    const { home } = await machine()

    const result = await sync(home, ['--source', `${raw}/v1.2.3`])

    expect(result.code, result.stdout).toBe(0)
    expect(result.stdout).toContain('release   v1.2.3')
    expect(await readFile(join(home, '.local/bin/croft'), 'utf8')).toBe('served:/raw/v1.2.3/cli/croft.mjs')
    expect(await readFile(join(home, '.croft/hooks/croft-context.mjs'), 'utf8')).toBe(
      'served:/raw/v1.2.3/hooks/croft-context.mjs',
    )
    expect(await readFile(join(home, '.claude/skills/croft/SKILL.md'), 'utf8')).toBe(
      'served:/raw/v1.2.3/skills/croft/SKILL.md',
    )
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((path) => path.startsWith('/raw/v1.2.3/'))).toBe(true)
  })

  it('never rewrites its own two scripts from a remote source', async () => {
    const { raw, requests } = await serve()
    const { home } = await machine()

    const checked = await sync(home, ['--source', `${raw}/v1.2.3`, '--check'])
    const written = await sync(home, ['--source', `${raw}/v1.2.3`])

    expect(written.code, written.stdout).toBe(0)
    expect(await readFile(join(home, '.croft/maintenance/sync-agent-files.mjs'), 'utf8')).toBe('old sync')
    expect(await readFile(join(home, '.croft/maintenance/install-cron.mjs'), 'utf8')).toBe('old installer')
    expect(written.stdout).toContain('updated by `croft setup`, never from a remote source')
    // Not reported as drift either: a skipped file is not a stale one.
    expect(checked.stdout).not.toMatch(/DRIFT\s+\S*maintenance/)
    expect(requests.some((path) => path.includes('/scripts/'))).toBe(false)
  })

  it('reads the pre-pinning main URL as the release installed here', async () => {
    const { raw, requests } = await serve()
    const { home } = await machine('0.3.0')

    const result = await sync(home, ['--source', LEGACY_MAIN], { CROFT_RAW_REPO: raw })

    expect(result.code, result.stdout).toBe(0)
    expect(result.stdout).toContain('pre-pinning default')
    expect(result.stdout).toContain('release   v0.3.0')
    expect(await readFile(join(home, '.local/bin/croft'), 'utf8')).toBe('served:/raw/v0.3.0/cli/croft.mjs')
    expect(requests.every((path) => path.startsWith('/raw/v0.3.0/'))).toBe(true)
  })

  it('follows a branch only when the job says --unpinned', async () => {
    const { raw, requests } = await serve()
    const { home } = await machine()

    const result = await sync(home, ['--source', `${raw}/main`, '--unpinned'])

    expect(result.code, result.stdout).toBe(0)
    expect(result.stdout).toContain('unpinned')
    expect(await readFile(join(home, '.local/bin/croft'), 'utf8')).toBe('served:/raw/main/cli/croft.mjs')
    expect(requests.every((path) => path.startsWith('/raw/main/'))).toBe(true)
  })

  it('updates its own scripts from a tree on disk, which somebody put there on purpose', async () => {
    const { home } = await machine()

    const result = await sync(home, ['--source', REPO])

    expect(result.code, result.stdout).toBe(0)
    expect(await readFile(join(home, '.croft/maintenance/sync-agent-files.mjs'), 'utf8')).toBe(
      await readFile(join(REPO, 'scripts/sync-agent-files.mjs'), 'utf8'),
    )
  })
})

describe('sync-agent-files refuses, and writes nothing', () => {
  const refused = async (args: string[], why: RegExp, { extra = {}, cliVersion = '1.2.3' as string | null } = {}) => {
    const { home, cli } = await machine(cliVersion)
    const result = await sync(home, args, extra)
    expect(result.code, result.stdout).toBe(1)
    expect(result.stdout).toMatch(why)
    expect(result.stdout).toContain('Nothing was written')
    expect(await readFile(join(home, '.local/bin/croft'), 'utf8')).toBe(cli)
    expect(existsSync(join(home, '.claude/skills/croft/SKILL.md'))).toBe(false)
    expect(existsSync(join(home, '.croft/hooks/croft-context.mjs'))).toBe(false)
    expect(await readFile(join(home, '.croft/maintenance/sync-agent-files.mjs'), 'utf8')).toBe('old sync')
  }

  it.each([['main'], ['v'], ['v1.2'], ['vmain'], ['1.2.3'], ['v1.2.3/../../evil']])(
    'a remote source ending in %j, which is not a release tag',
    async (ref) => {
      const { raw, requests } = await serve()
      await refused(['--source', `${raw}/${ref}`], /does not end in a release tag|\. or \.\. segment/)
      expect(requests).toEqual([])
    },
  )

  it('an empty --source', async () => {
    await refused(['--source', ''], /--source is empty/)
  })

  it('when one file of the release is missing, not the files before it', async () => {
    const { raw } = await serve(['hooks/croft-context.mjs'])
    await refused(['--source', `${raw}/v1.2.3`], /hooks\/croft-context\.mjs returned 404/)
  })

  it('a source over plain http', async () => {
    await refused(['--source', 'http://mirror.example/croft/v1.2.3'], /is not https/)
  })

  it('a pre-pinning job on a machine with no installed CLI to read the release from', async () => {
    const { raw, requests } = await serve()
    await refused(['--source', LEGACY_MAIN], /no installed croft CLI/, { extra: { CROFT_RAW_REPO: raw }, cliVersion: null })
    expect(requests).toEqual([])
  })

  it('a pre-pinning job whose installed CLI carries no release number', async () => {
    const { raw, requests } = await serve()
    await refused(['--source', LEGACY_MAIN], /not a release number/, { extra: { CROFT_RAW_REPO: raw }, cliVersion: 'main' })
    expect(requests).toEqual([])
  })

  it('a pre-pinning job pointed at a plain-http mirror', async () => {
    await refused(['--source', LEGACY_MAIN], /is not https/, { extra: { CROFT_RAW_REPO: 'http://mirror.example/croft' } })
  })
})

const VERSION = readFileSync(join(REPO, 'cli/croft.mjs'), 'utf8').match(/^const VERSION = '([^']+)'/m)?.[1]

/** The agent-files job as install-cron would schedule it, printed and never installed. */
const plan = async (extra: Record<string, string> = {}) => {
  const home = await temp('croft-pin-cron-')
  const script = join(home, 'sync.mjs')
  await writeFile(script, '')
  const result = await run(process.execPath, ['scripts/install-cron.mjs', '--cron', '--only', 'agent-files'], {
    PATH: BASE_PATH,
    HOME: home,
    CROFT_SYNC_SCRIPT: script,
    CROFT_NODE_PATH: process.execPath,
    CROFT_LOG_DIR: home,
    ...extra,
  })
  const line = result.stdout.split('\n').find((l) => l.startsWith('23 * * * *')) ?? ''
  return { ...result, line, home }
}

describe('install-cron — the agent-files job source', () => {
  it('schedules the tag of the release it ships with, never main, and not --unpinned', async () => {
    const { code, line } = await plan()
    expect(code).toBe(0)
    expect(line).toContain(`'--source' 'https://raw.githubusercontent.com/montytorr/croft/v${VERSION}'`)
    expect(line).not.toContain('/main')
    expect(line).not.toContain('--unpinned')
  })

  it('follows a fork named by CROFT_REPO, and refuses one that is not <owner>/<name>', async () => {
    const fork = await plan({ CROFT_REPO: 'acme/croft' })
    expect(fork.line).toContain(`'--source' 'https://raw.githubusercontent.com/acme/croft/v${VERSION}'`)

    for (const bad of ['acme', 'acme/croft/extra', 'acme/..', 'a b/c']) {
      const refused = await plan({ CROFT_REPO: bad })
      expect(refused.code, bad).toBe(2)
      expect(refused.stderr).toContain('is not <owner>/<name>')
    }
  })

  it('takes a mirror as CROFT_RAW_REPO, over https only', async () => {
    const mirror = await plan({ CROFT_RAW_REPO: 'https://mirror.example/croft/' })
    expect(mirror.line).toContain(`'--source' 'https://mirror.example/croft/v${VERSION}'`)

    const clear = await plan({ CROFT_RAW_REPO: 'http://mirror.example/croft' })
    expect(clear.code).toBe(2)
    expect(clear.stderr).toContain('is not https')
  })

  it('follows CROFT_RAW_BASE only as an explicit, labelled opt-in', async () => {
    const branch = await plan({ CROFT_RAW_BASE: 'https://raw.example/main' })
    expect(branch.line).toContain("'--source' 'https://raw.example/main' '--unpinned'")

    const tag = await plan({ CROFT_RAW_BASE: 'https://raw.example/v1.2.3' })
    expect(tag.line).toContain("'--source' 'https://raw.example/v1.2.3'")
    expect(tag.line).not.toContain('--unpinned')

    const clear = await plan({ CROFT_RAW_BASE: 'http://raw.example/main' })
    expect(clear.code).toBe(2)
    expect(clear.stderr).toContain('is not https')
  })
})

/**
 * The scheduled sync no longer refreshes its own scripts, so `--install` does:
 * from the tree the installer runs from, at the default location. The default
 * location is ~/.croft/maintenance on macOS only (/opt on Linux, which a test
 * cannot write), and cron is faked so nothing real is scheduled.
 */
describe.skipIf(process.platform !== 'darwin')('install-cron --install places the maintenance scripts', () => {
  it('replaces stale copies at the default location with the ones it ships with', async () => {
    const home = await temp('croft-pin-place-')
    const bin = join(home, 'bin')
    await mkdir(bin, { recursive: true })
    const crontab = join(home, 'crontab.txt')
    await writeFile(crontab, '')
    await writeFile(join(bin, 'crontab'), `#!/bin/sh\nif [ "$1" = "-l" ]; then cat "${crontab}"; else cat > "${crontab}"; fi\n`)
    await chmod(join(bin, 'crontab'), 0o755)
    await mkdir(join(home, '.croft/maintenance'), { recursive: true })
    await writeFile(join(home, '.croft/maintenance/sync-agent-files.mjs'), 'old sync')
    await writeFile(join(home, '.croft/maintenance/install-cron.mjs'), 'old installer')

    const result = await run(process.execPath, ['scripts/install-cron.mjs', '--cron', '--install', '--only', 'agent-files'], {
      PATH: `${bin}:${BASE_PATH}`,
      HOME: home,
      CROFT_NODE_PATH: process.execPath,
      CROFT_LOG_DIR: home,
    })

    expect(result.code, result.stderr).toBe(0)
    for (const name of ['sync-agent-files.mjs', 'install-cron.mjs']) {
      expect(await readFile(join(home, '.croft/maintenance', name), 'utf8')).toBe(
        await readFile(join(REPO, 'scripts', name), 'utf8'),
      )
    }
    expect(await readFile(crontab, 'utf8')).toContain(`/v${VERSION}'`)
  })
})

describe('install.sh CROFT_REPO', () => {
  it.each([['acme'], ['acme/croft/extra'], ['acme/..'], ['../croft'], ['acme/cr ft'], ['https://evil.example/x']])(
    'refuses %j before downloading anything',
    async (repo) => {
      const home = await temp('croft-pin-install-')
      const result = await run('sh', ['install.sh', '--url', 'http://127.0.0.1:9'], {
        PATH: BASE_PATH,
        HOME: home,
        CROFT_REPO: repo,
      })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('is not <owner>/<name>')
      expect(existsSync(join(home, '.local'))).toBe(false)
    },
  )
})

/**
 * CROFT-14: `croft setup --runtimes claude-code` used to leave a job that still
 * wrote the Codex skill wherever ~/.codex existed.
 */
describe.skipIf(SYSTEM_TARGETS)('sync-agent-files --runtimes', () => {
  it('writes only the skill copies of the runtimes it is given', async () => {
    const { raw } = await serve()
    const { home } = await machine()
    await mkdir(join(home, '.codex'), { recursive: true })

    const result = await sync(home, ['--source', `${raw}/v1.2.3`, '--runtimes', 'claude-code'])

    expect(result.code, result.stdout).toBe(0)
    expect(existsSync(join(home, '.claude/skills/croft/SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.codex/skills/croft/SKILL.md'))).toBe(false)
    expect(result.stdout).toContain('(codex was not set up here)')
  })

  it('without --runtimes, writes every runtime whose directory exists, as before', async () => {
    const { raw } = await serve()
    const { home } = await machine()
    await mkdir(join(home, '.codex'), { recursive: true })

    const result = await sync(home, ['--source', `${raw}/v1.2.3`])

    expect(result.code, result.stdout).toBe(0)
    expect(existsSync(join(home, '.codex/skills/croft/SKILL.md'))).toBe(true)
  })
})

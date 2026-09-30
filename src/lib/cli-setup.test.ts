import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * `croft setup` (CROFT-314): one command that connects a machine to a Croft
 * instance and installs everything the four scripts used to do by hand. This
 * exercises the CLI half against a fake server that speaks the pairing
 * contract exactly (connect / connect/poll / health / people), never the
 * real GitHub download — CROFT_SETUP_SOURCE points at this checkout instead,
 * which is also what makes the test hermetic and fast.
 *
 * Every non-dry-run case passes --no-hooks --no-jobs: install-cron.mjs's
 * --install runs real `launchctl` on macOS, and this suite must never touch
 * this machine for real. --dry-run cases need neither flag, because a dry
 * run never installs anything to begin with.
 */

const REPO = process.cwd()
const CLI = join(REPO, 'cli', 'croft.mjs')

const servers: Server[] = []
const homes: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(homes.splice(0).map((h) => rm(h, { recursive: true, force: true })))
})

type ConnectState = {
  status?: 'pending' | 'denied' | 'expired' | 'approved'
  pendingCount?: number
  expiresIn?: number
  interval?: number
  keys?: { agentName: string; key: string }[]
  user?: { name?: string; email?: string }
  no404?: boolean
  /** Poll answers `denied` for a pairing that asked for any of these. */
  denyRuntimes?: string[]
  /** Every POST /connect body the CLI sent, in order. */
  requests?: { runtimes: string[]; host: string }[]
}

/** A fake Croft server: health, people (key validity), connect, connect/poll. */
const serve = (state: ConnectState = {}) =>
  new Promise<string>((resolve) => {
    let polls = 0
    const asked = new Map<string, string[]>()
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const json = (data: unknown, code = 200) => {
          res.writeHead(code, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: code < 400, data }))
        }
        if (req.url === '/api/v1/health') return json({ version: '0.10.1', build: 'test' })
        if (req.url === '/api/v1/people') {
          const auth = req.headers.authorization ?? ''
          return auth === 'Bearer sk_valid' ? json([]) : json(null, 401)
        }
        if (req.url === '/api/v1/connect') {
          if (state.status === undefined && state.no404) {
            res.writeHead(404, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ success: false, error: 'not found' }))
          }
          const body = JSON.parse(raw || '{}')
          state.requests?.push(body)
          const deviceCode = `device-${asked.size + 1}`
          asked.set(deviceCode, body.runtimes ?? [])
          return json({
            deviceCode,
            userCode: 'AB12-CD34',
            verificationUrl: 'http://127.0.0.1/connect/AB12-CD34',
            expiresIn: state.expiresIn ?? 60,
            interval: state.interval ?? 0,
          })
        }
        if (req.url === '/api/v1/connect/poll') {
          polls += 1
          const runtimes = asked.get(JSON.parse(raw || '{}').deviceCode) ?? []
          if (state.denyRuntimes?.some((r) => runtimes.includes(r))) return json({ status: 'denied' })
          if (state.status === 'pending' && polls <= (state.pendingCount ?? 1)) return json({ status: 'pending' })
          if (state.status === 'denied') return json({ status: 'denied' })
          if (state.status === 'expired') return json({ status: 'expired' })
          return json({ status: 'approved', user: state.user ?? { name: 'Julien' }, keys: state.keys ?? [] })
        }
        json({ error: 'unhandled' }, 404)
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const home = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'croft-setup-'))
  homes.push(dir)
  return dir
}

const RUNTIME_MARKERS = /^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCLAW_|CROFT_AGENT$|CROFT_SESSION_ID$)/

const run = (args: string[], HOME: string, extraEnv: Record<string, string> = {}) => {
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (RUNTIME_MARKERS.test(name)) delete env[name]
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...env, HOME, CROFT_SETUP_SOURCE: REPO, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('croft setup — dry run', () => {
  it('prints the plan and writes nothing', async () => {
    const base = await serve()
    const HOME = await home()
    const { code, stdout } = await run(['setup', '--url', base, '--runtimes', 'claude-code', '--dry-run'], HOME)
    expect(code).toBe(0)
    expect(stdout).toContain('would write CROFT_BASE_URL')
    expect(stdout).toContain(`✓ server    ${base}`)
    expect(stdout).toContain('would be paired (--dry-run: skipped)')
    expect(existsSync(join(HOME, '.croft', 'env'))).toBe(false)
    expect(existsSync(join(HOME, '.local', 'bin', 'croft'))).toBe(false)
  })

  it('offers OpenClaw only where this account runs its gateway', async () => {
    const base = await serve()
    const { mkdir, writeFile } = await import('node:fs/promises')
    const plan = async (config: unknown) => {
      const HOME = await home()
      await mkdir(join(HOME, '.claude'), { recursive: true })
      await mkdir(join(HOME, '.openclaw'), { recursive: true })
      await writeFile(join(HOME, '.openclaw', 'openclaw.json'), JSON.stringify(config))
      return (await run(['setup', '--url', base, '--dry-run'], HOME)).stdout
    }
    // A client config only reaches someone else's gateway.
    expect(await plan({ gateway: { auth: { token: 'x' } } })).toContain('! keys      claude-code would be paired')
    expect(await plan({ gateway: { port: 18789 } })).toContain('claude-code, openclaw would be paired')
  })

  it('stops with a clear error against an unreachable url', async () => {
    const HOME = await home()
    const { code, stdout, stderr } = await run(
      ['setup', '--url', 'http://127.0.0.1:1', '--runtimes', 'claude-code', '--dry-run'],
      HOME,
    )
    expect(code).not.toBe(0)
    expect(stdout + stderr).toContain('cannot reach http://127.0.0.1:1/api/v1/health')
  })
})

/**
 * Croft records no sessions — Cairn does — so setup plans only the agent-files
 * job, and reconcile with --maintenance. Dry-run only: --install would run
 * real launchctl, which this suite must never do.
 */
describe('croft setup — jobs', () => {
  it('plans agent-files alone, never a session sweep, even for OpenClaw', async () => {
    const base = await serve()
    const HOME = await home()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(HOME, '.openclaw', 'agents', 'main', 'agent', 'codex-home', 'sessions'), { recursive: true })
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'openclaw', '--no-hooks', '--dry-run'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).not.toContain('openclaw-sessions')
    expect(stdout).not.toContain('vitals')
  })
})

describe('croft setup — pairing', () => {
  it('pairs, prints who approved it, and writes the key at mode 600', async () => {
    const base = await serve({ status: 'pending', pendingCount: 1, keys: [{ agentName: 'claude-code', key: 'sk_new' }], user: { name: 'Julien' } })
    const HOME = await home()
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('Open this link to connect this machine')
    expect(stdout).toContain('AB12-CD34')
    expect(stdout).toContain('✓ approved by Julien')

    const envPath = join(HOME, '.croft', 'env')
    const content = await readFile(envPath, 'utf8')
    expect(content).toContain('CROFT_API_KEY_CLAUDE_CODE=sk_new')
    const mode = (await stat(envPath)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('reports a denial and exits non-zero', async () => {
    const base = await serve({ status: 'denied' })
    const HOME = await home()
    const { code, stdout, stderr } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).not.toBe(0)
    expect(stdout + stderr).toContain('denied')
  })

  it('reports expiry and exits non-zero', async () => {
    const base = await serve({ status: 'expired', expiresIn: 0 })
    const HOME = await home()
    const { code, stdout, stderr } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).not.toBe(0)
    expect(stdout + stderr).toContain('expired')
  })

  it('falls back with a clear message on a server that predates pairing (404)', async () => {
    const base = await serve({ no404: true })
    const HOME = await home()
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('this server predates pairing')
    expect(stdout).toContain(`${base}/users`)
    expect(stdout).toContain('CROFT_API_KEY_CLAUDE_CODE=')
    // It continues with the rest of setup rather than stopping dead.
    expect(existsSync(join(HOME, '.local', 'bin', 'croft'))).toBe(true)
  })

  it('tightens an env file that already existed with looser permissions', async () => {
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_new' }] })
    const HOME = await home()
    const { mkdir, writeFile, chmod } = await import('node:fs/promises')
    await mkdir(join(HOME, '.croft'), { recursive: true })
    const envPath = join(HOME, '.croft', 'env')
    await writeFile(envPath, `CROFT_BASE_URL=${base}\n`)
    await chmod(envPath, 0o644)
    const { code } = await run(['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'], HOME)
    expect(code).toBe(0)
    expect((await stat(envPath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(HOME, '.croft'))).mode & 0o777).toBe(0o700)
  })

  it('pairs a maintenance key on its own, so a member still gets their agents\' keys', async () => {
    const requests: { runtimes: string[]; host: string }[] = []
    const base = await serve({
      status: 'approved',
      keys: [{ agentName: 'claude-code', key: 'sk_member' }],
      denyRuntimes: ['maintenance'],
      requests,
    })
    const HOME = await home()
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--maintenance', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(requests.map((r) => r.runtimes)).toEqual([['claude-code'], ['maintenance']])
    expect(requests[0]!.host).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(stdout).toContain('maintenance not issued')
    expect(await readFile(join(HOME, '.croft', 'env'), 'utf8')).toContain('CROFT_API_KEY_CLAUDE_CODE=sk_member')
  })

  it('replaces a stale key in place rather than duplicating the line', async () => {
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_fresh' }] })
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.croft'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(HOME, '.croft', 'env'),
      `CROFT_BASE_URL=${base}\n# a comment, kept\nCROFT_API_KEY_CLAUDE_CODE=sk_stale\n`,
      { mode: 0o600 },
    )
    const { code } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    const content = await readFile(join(HOME, '.croft', 'env'), 'utf8')
    expect(content.match(/CROFT_API_KEY_CLAUDE_CODE=/g)).toHaveLength(1)
    expect(content).toContain('CROFT_API_KEY_CLAUDE_CODE=sk_fresh')
    expect(content).not.toContain('sk_stale')
    expect(content).toContain('# a comment, kept')
  })

  it('keeps a key that still authenticates, without re-pairing', async () => {
    const base = await serve()
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.croft'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(HOME, '.croft', 'env'),
      `CROFT_BASE_URL=${base}\nCROFT_API_KEY_CLAUDE_CODE=sk_valid\n`,
      { mode: 0o600 },
    )
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('claude-code already set, and still work')
    expect(stdout).not.toContain('Open this link to connect this machine')
  })
})

describe('croft setup — idempotent re-run', () => {
  it('a second run keeps the key and reports the cli/skill as unchanged', async () => {
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_valid' }] })
    const HOME = await home()
    const first = await run(['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'], HOME)
    expect(first.code).toBe(0)

    // The fake server's /people only accepts sk_valid, so the key just
    // written passes the second run's validity check.
    const second = await run(['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'], HOME)
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('claude-code already set, and still work')
    expect(second.stdout).toContain('cli') // unchanged line still names the step
    expect(second.stdout).toContain('unchanged')

    const content = await readFile(join(HOME, '.croft', 'env'), 'utf8')
    expect(content.match(/CROFT_API_KEY_CLAUDE_CODE=/g)).toHaveLength(1)
  })
})

describe('croft setup — multi-instance naming', () => {
  it('derives a name from the url, skipping generic host labels', async () => {
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.croft'), { recursive: true, mode: 0o700 })
    await writeFile(join(HOME, '.croft', 'env'), 'CROFT_BASE_URL=https://old.example.com\n', { mode: 0o600 })

    const base = await serve()
    // The fake server is on 127.0.0.1:<port>, which has no meaningful labels
    // to skip, so it derives to its own first label; the point of this case
    // is that a *different* url than the one on disk triggers multi-instance
    // mode and registers a name rather than overwriting ~/.croft/env.
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--dry-run'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('would register')
    expect(existsSync(join(HOME, '.croft', 'instances.json'))).toBe(false) // dry-run changed nothing
    const untouched = await readFile(join(HOME, '.croft', 'env'), 'utf8')
    expect(untouched).toContain('old.example.com')
  })

  it('adopts the existing single instance before adding a second, so the first keeps working', async () => {
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.croft'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(HOME, '.croft', 'env'),
      'CROFT_BASE_URL=https://tasks.example.com\nCROFT_API_KEY_CLAUDE_CODE=sk_first\n',
      { mode: 0o600 },
    )
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_second' }] })
    const { code, stdout } = await run(
      ['setup', '--url', base, '--name', 'work', '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('adopted from ~/.croft/env, still the default')

    const config = JSON.parse(await readFile(join(HOME, '.croft', 'instances.json'), 'utf8'))
    expect(Object.keys(config.instances).sort()).toEqual(['tasks', 'work'])
    expect(config.instances.tasks.url).toBe('https://tasks.example.com')
    expect(config.unclassified).toEqual({ mode: 'default', instance: 'tasks' })
    expect(await readFile(join(HOME, '.croft', 'instances', 'tasks', 'env'), 'utf8')).toContain('sk_first')
    expect(await readFile(join(HOME, '.croft', 'instances', 'work', 'env'), 'utf8')).toContain('sk_second')
  })

  it('--name overrides the derived name', async () => {
    const HOME = await home()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(HOME, '.croft'), { recursive: true, mode: 0o700 })
    await writeFile(join(HOME, '.croft', 'env'), 'CROFT_BASE_URL=https://old.example.com\n', { mode: 0o600 })

    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_new' }] })
    const { code, stdout } = await run(
      ['setup', '--url', base, '--name', 'work', '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain('work ->')
    const instances = JSON.parse(await readFile(join(HOME, '.croft', 'instances.json'), 'utf8'))
    expect(instances.instances.work.url).toBe(base)
    const envPath = join(HOME, '.croft', 'instances', 'work', 'env')
    expect(existsSync(envPath)).toBe(true)
    const content = await readFile(envPath, 'utf8')
    expect(content).toContain('CROFT_API_KEY_CLAUDE_CODE=sk_new')
  })
})

describe('croft setup — CROFT_SETUP_SOURCE', () => {
  it('installs the cli and skill straight from the local checkout, no download attempted', async () => {
    const base = await serve({ status: 'approved', keys: [{ agentName: 'claude-code', key: 'sk_new' }] })
    const HOME = await home()
    const { code, stdout } = await run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs'],
      HOME,
    )
    expect(code).toBe(0)
    expect(stdout).toContain(`${REPO} (CROFT_SETUP_SOURCE)`)
    const installed = await readFile(join(HOME, '.local', 'bin', 'croft'), 'utf8')
    const source = await readFile(CLI, 'utf8')
    expect(installed).toBe(source)
    expect(existsSync(join(HOME, '.claude', 'skills', 'croft', 'SKILL.md'))).toBe(true)
    // No release was fetched from GitHub or cached under ~/.croft/releases.
    expect(existsSync(join(HOME, '.croft', 'releases'))).toBe(false)
  })

  it('copies the skill for each runtime and wires hooks around Cairn, the same on a second run', async () => {
    const base = await serve({
      status: 'approved',
      keys: [{ agentName: 'claude-code', key: 'sk_valid' }, { agentName: 'codex', key: 'sk_valid' }],
    })
    const HOME = await home()
    await mkdir(join(HOME, '.claude'), { recursive: true })
    await mkdir(join(HOME, '.codex'), { recursive: true })
    const cairn = { type: 'command', command: 'node /h/.cairn/hooks/cairn-context.mjs', 'cairn-memory': true, timeout: 10 }
    const guard = { matcher: 'Bash', hooks: [{ type: 'command', command: '/guard.sh' }] }
    await writeFile(
      join(HOME, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', hooks: { SessionStart: [{ matcher: 'startup', hooks: [cairn] }], PreToolUse: [guard] } }),
    )
    const quarry = { hooks: [{ type: 'command', command: 'node /x/quarry-stop.mjs' }] }
    await writeFile(join(HOME, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [quarry] } }))
    const sandbox = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CROFT_OPENCLAW_BIN: 'openclaw-not-installed' }
    const args = ['setup', '--url', base, '--runtimes', 'claude-code,codex', '--no-jobs']

    const first = await run(args, HOME, sandbox)
    expect(first.code, first.stderr).toBe(0)
    for (const runtime of ['.claude', '.codex']) {
      expect(await readFile(join(HOME, runtime, 'skills', 'croft', 'SKILL.md'), 'utf8')).toBe(
        await readFile(join(REPO, 'skills', 'croft', 'SKILL.md'), 'utf8'),
      )
    }
    expect(first.stdout).toContain('claude: briefing: carried by Cairn')
    const claude = JSON.parse(await readFile(join(HOME, '.claude', 'settings.json'), 'utf8'))
    expect(claude).toEqual({ model: 'opus', hooks: { SessionStart: [{ matcher: 'startup', hooks: [cairn] }], PreToolUse: [guard] } })
    const codex = JSON.parse(await readFile(join(HOME, '.codex', 'hooks.json'), 'utf8'))
    expect(codex.hooks.Stop).toEqual([quarry])
    expect(codex.hooks.SessionStart).toEqual([
      {
        matcher: 'startup|resume|clear',
        hooks: [expect.objectContaining({ command: expect.stringMatching(/croft-context\.mjs$/), 'croft-memory': true })],
      },
    ])

    const files = async () =>
      Promise.all(['.claude/settings.json', '.codex/hooks.json'].map((f) => readFile(join(HOME, f), 'utf8')))
    const written = await files()
    const second = await run(args, HOME, sandbox)
    expect(second.code, second.stderr).toBe(0)
    expect(second.stdout).toContain('skill     ~/.claude/skills/croft, ~/.codex/skills/croft — unchanged')
    // Byte for byte: Codex re-asks trust for any entry whose hash moves.
    expect(await files()).toEqual(written)
  })
})

/**
 * The agent-files job overwrites code every agent session runs, on a timer, so
 * setup says so before installing it. Dry run: the plan is what install-cron
 * would render, printed and never installed.
 */
describe('croft setup — the agent-files job', () => {
  const planned = async (extraEnv: Record<string, string> = {}) => {
    const base = await serve()
    const HOME = await home()
    const script = join(HOME, 'sync.mjs')
    await writeFile(script, '')
    return run(
      ['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--dry-run'],
      HOME,
      { CROFT_SYNC_SCRIPT: script, CROFT_NODE_PATH: process.execPath, CROFT_LOG_DIR: HOME, ...extraEnv },
    )
  }

  it('says what the job overwrites, how often, from where, and how to skip or remove it', async () => {
    const { code, stdout } = await planned()
    const version = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')).version
    expect(code).toBe(0)
    expect(stdout).toContain('agent-files keeps ~/.local/bin/croft, ~/.croft/hooks and the skill')
    expect(stdout).toContain(`v${version}, the release installed here, from github.com/montytorr/croft`)
    expect(stdout).toMatch(/every 15 minutes and at login|hourly/)
    expect(stdout).toContain('--no-jobs skips it')
    expect(stdout).toContain('--remove --only agent-files takes it out')
    // Said before the job's plan, not after it.
    expect(stdout.indexOf('agent-files keeps')).toBeLessThan(stdout.indexOf('jobs      agent-files'))
    expect(stdout).toContain(`/v${version}`)
  })

  it('names a fork given as CROFT_REPO, and refuses one that is not <owner>/<name>', async () => {
    const fork = await planned({ CROFT_REPO: 'acme/croft' })
    expect(fork.stdout).toContain('from github.com/acme/croft')

    const bad = await planned({ CROFT_REPO: 'acme/../evil' })
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toContain('is not <owner>/<name>')
  })
})

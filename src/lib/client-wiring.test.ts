import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { hostOf } from './api/auth'
import { withHost } from './api/activity'

/**
 * CROFT-290: the ways a correctly written CLI still ended up speaking with the
 * wrong identity, from the wrong machine, or out of date — each exercised the
 * way a runtime meets it, by spawning the real file.
 *
 * Every environment below is built from nothing rather than from
 * process.env, because this suite is itself usually run from inside Claude
 * Code or Codex, and their markers leaking in would make detection pass for
 * the wrong reason.
 */

const REPO = resolve(__dirname, '../..')
const CLI = join(REPO, 'cli/croft.mjs')
const NODE_DIR = dirname(process.execPath)
const BASE_PATH = `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`

const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const temp = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

type Seen = { url: string; headers: IncomingHttpHeaders }

const serve = (headers: Record<string, string> = {}) =>
  new Promise<{ base: string; seen: Seen[] }>((done) => {
    const seen: Seen[] = []
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json', ...headers })
      const data = req.url?.startsWith('/api/v1/health')
        ? { status: 'ok', version: headers['x-croft-version'] ?? '0.0.0', build: 'test' }
        : []
      res.end(JSON.stringify({ success: true, data }))
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () =>
      done({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen }),
    )
  })

const run = (command: string, args: string[], env: Record<string, string>, cwd = REPO) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', fail)
    child.on('close', (code) => done({ code, stdout, stderr }))
  })

const homeWith = async (envFile: string) => {
  const home = await temp('croft-wiring-home-')
  await mkdir(join(home, '.croft'))
  await writeFile(join(home, '.croft/env'), envFile)
  return home
}

const bearer = (seen: Seen[]) => String(seen[0]?.headers.authorization ?? '').replace(/^Bearer /, '')

const SPLIT = [
  'CROFT_API_KEY=croft_default',
  'CROFT_API_KEY_CLAUDE_CODE=croft_claude',
  'CROFT_API_KEY_CODEX=croft_codex',
].join('\n')

/**
 * A stand-in for a runtime binary: a node script called `codex` or `claude`
 * that runs the command it is handed. What matters is its name in the process
 * table, which is all the CLI looks at.
 */
const fakeRuntime = async (dir: string, name: 'codex' | 'claude') => {
  const path = join(dir, name)
  await writeFile(
    path,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const [command, ...args] = process.argv.slice(2)
const r = spawnSync(command, args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
`,
  )
  await chmod(path, 0o755)
  return path
}

describe('which runtime is innermost', () => {
  const setUp = async () => {
    const { base, seen } = await serve()
    const home = await homeWith(SPLIT)
    const bin = await temp('croft-wiring-bin-')
    const codex = await fakeRuntime(bin, 'codex')
    const claude = await fakeRuntime(bin, 'claude')
    const env = { PATH: BASE_PATH, HOME: home, CROFT_BASE_URL: base, CROFT_HOST: 'test-box' }
    return { seen, env, codex, claude }
  }

  it('files a Codex started from a Claude Code shell as Codex', async () => {
    const { seen, env, codex } = await setUp()
    // Exactly what that Codex's commands see: Claude Code's marker, inherited,
    // and Codex's own.
    const nested = { ...env, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEX_THREAD_ID: 't-1' }
    const out = await run(codex, ['node', CLI, 'projects'], nested)
    expect(out.code, out.stderr).toBe(0)
    expect(bearer(seen)).toBe('croft_codex')
  })

  it('files a Claude Code started from a Codex shell as Claude Code', async () => {
    const { seen, env, codex, claude } = await setUp()
    const nested = { ...env, CLAUDECODE: '1', CODEX_THREAD_ID: 't-1', CODEX_MANAGED_BY_NPM: '1' }
    const out = await run(codex, [claude, 'node', CLI, 'projects'], nested)
    expect(out.code, out.stderr).toBe(0)
    expect(bearer(seen)).toBe('croft_claude')
  })

  it('keeps plain Claude Code as Claude Code, and plain Codex as Codex', async () => {
    const claudeOnly = await setUp()
    await run('node', [CLI, 'projects'], { ...claudeOnly.env, CLAUDECODE: '1' })
    expect(bearer(claudeOnly.seen)).toBe('croft_claude')

    const codexOnly = await setUp()
    await run('node', [CLI, 'projects'], { ...codexOnly.env, CODEX_THREAD_ID: 't-2' })
    expect(bearer(codexOnly.seen)).toBe('croft_codex')
  })

  it('keeps the old answer when the process tree names no runtime', async () => {
    const { seen, env } = await setUp()
    await run('node', [CLI, 'projects'], { ...env, CLAUDECODE: '1', CODEX_THREAD_ID: 't-3' })
    expect(bearer(seen)).toBe('croft_claude')
  })
})

describe('the maintenance identity never borrows a key', () => {
  it('refuses, loudly and before sending anything, when it has no key of its own', async () => {
    const { base, seen } = await serve()
    const home = await homeWith(SPLIT)
    const out = await run('node', [CLI, 'note', 'CROFT-1', 'x'], {
      PATH: BASE_PATH, HOME: home, CROFT_BASE_URL: base, CROFT_AGENT: 'maintenance',
    })
    expect(out.code).toBe(3)
    expect(out.stderr).toContain('CROFT_API_KEY_MAINTENANCE')
    expect(seen).toHaveLength(0)
  })

  it('uses its own key when there is one', async () => {
    const { base, seen } = await serve()
    const home = await homeWith(`${SPLIT}\nCROFT_API_KEY_MAINTENANCE=croft_maint`)
    const out = await run('node', [CLI, 'projects'], {
      PATH: BASE_PATH, HOME: home, CROFT_BASE_URL: base, CROFT_AGENT: 'maintenance',
    })
    expect(out.code, out.stderr).toBe(0)
    expect(bearer(seen)).toBe('croft_maint')
  })

  it('still works on a machine that was never split into per-runtime keys', async () => {
    const { base, seen } = await serve()
    const home = await homeWith('CROFT_API_KEY=croft_only')
    const out = await run('node', [CLI, 'projects'], {
      PATH: BASE_PATH, HOME: home, CROFT_BASE_URL: base, CROFT_AGENT: 'maintenance',
    })
    expect(out.code, out.stderr).toBe(0)
    expect(bearer(seen)).toBe('croft_only')
  })

  it('makes the sync job say so on every run, not only when it reports', async () => {
    const home = await homeWith(SPLIT)
    // --check writes nothing, which matters: the sync's targets include
    // /usr/local/bin/croft on whatever machine runs this suite.
    const out = await run('node', ['scripts/sync-agent-files.mjs', '--check', '--notify', 'CROFT-1'], {
      PATH: BASE_PATH, HOME: home, CROFT_AGENT: 'maintenance',
    })
    expect(out.stdout).toContain('WARNING: CROFT_AGENT=maintenance')
    expect(out.stdout).toContain('CROFT_API_KEY_MAINTENANCE')
    expect(out.code).not.toBe(0)
  })
})

describe('the sync job on a machine with several instances (CROFT-301)', () => {
  const withInstances = async (personalEnv: string) => {
    const home = await homeWith('')
    await writeFile(join(home, '.croft/instances.json'), JSON.stringify({
      version: 1, instances: { personal: { url: 'https://a.example' }, work: { url: 'https://b.example' } },
    }))
    await mkdir(join(home, '.croft/instances/personal'), { recursive: true })
    await writeFile(join(home, '.croft/instances/personal/env'), personalEnv)
    return home
  }
  const check = (home: string, notify: string) =>
    run('node', ['scripts/sync-agent-files.mjs', '--check', '--notify', notify], {
      PATH: BASE_PATH, HOME: home, CROFT_AGENT: 'maintenance',
    })

  it('asks for the instance when --notify names only a ref', async () => {
    const out = await check(await withInstances(SPLIT), 'CROFT-1')
    expect(out.stdout).toContain('does not say which one CROFT-1 is on')
    expect(out.stdout).toContain('<instance>:CROFT-1')
    expect(out.code).not.toBe(0)
  })

  it("checks the named instance's own env for a maintenance key", async () => {
    const missing = await check(await withInstances(SPLIT), 'personal:CROFT-1')
    expect(missing.stdout).toContain(join('.croft', 'instances', 'personal', 'env'))
    expect(missing.code).not.toBe(0)

    const present = await check(await withInstances(`${SPLIT}\nCROFT_API_KEY_MAINTENANCE=m`), 'personal:CROFT-1')
    expect(present.stdout).not.toContain('WARNING')
  })
})

describe('the machine travels beside the actor', () => {
  it('sends the host, and the actor key is unchanged', async () => {
    const { base, seen } = await serve()
    const home = await homeWith('CROFT_API_KEY=croft_only')
    await run('node', [CLI, 'projects'], { PATH: BASE_PATH, HOME: home, CROFT_BASE_URL: base, CROFT_HOST: 'clawdius' })
    expect(seen[0]?.headers['x-croft-host']).toBe('clawdius')
  })

  it('drops a host it could not store safely rather than sanitising it', async () => {
    const { base, seen } = await serve()
    const home = await homeWith('CROFT_API_KEY=croft_only')
    await run('node', [CLI, 'projects'], { PATH: BASE_PATH, HOME: home, CROFT_BASE_URL: base, CROFT_HOST: 'a b;c' })
    expect(seen[0]?.headers['x-croft-host']).toBeUndefined()
  })

  it('is read by the server with the same filter, and folded into event data', () => {
    const req = (host?: string) =>
      new Request('http://x', { headers: host === undefined ? {} : { 'x-croft-host': host } })
    expect(hostOf(req('mac-mini.local'))).toBe('mac-mini.local')
    expect(hostOf(req('a b'))).toBeNull()
    expect(hostOf(req())).toBeNull()

    const event = { actor_type: 'agent', actor_id: 'codex · a@b', event: 'claimed', data: { x: 1 } }
    expect(withHost([event], 'box')[0]!.data).toEqual({ x: 1, host: 'box' })
    expect(withHost([event], null)[0]).toBe(event)
    expect(withHost([{ ...event, data: { host: 'kept' } }], 'box')[0]!.data).toEqual({ host: 'kept' })
  })
})

describe('which side of a drift is newer', () => {
  const release = async () => JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')).version as string

  const warn = async (headers: Record<string, string>, args = ['projects']) => {
    const { base } = await serve(headers)
    const home = await homeWith('CROFT_API_KEY=croft_only')
    return run('node', [CLI, ...args], { PATH: BASE_PATH, HOME: home, CROFT_BASE_URL: base })
  }

  it('says the CLI is older when the server is a later release', async () => {
    const { stderr } = await warn({ 'x-croft-version': '99.0.0' })
    expect(stderr).toContain('this CLI is older than the server')
    expect(stderr).toContain('update:')
  })

  it('says the CLI is newer when the server is an earlier release, and does not tell it to update', async () => {
    const { stderr } = await warn({ 'x-croft-version': '0.0.1' })
    expect(stderr).toContain('this CLI is newer than the server')
    expect(stderr).not.toContain('update:')
  })

  it('orders the same release by build time against install time', async () => {
    const version = await release()
    const future = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')
    const older = await warn({ 'x-croft-version': version, 'x-croft-cli': '0123456789abcdef', 'x-croft-built-at': future })
    expect(older.stderr).toContain('this CLI is older than the server')

    const newer = await warn({ 'x-croft-version': version, 'x-croft-cli': '0123456789abcdef', 'x-croft-built-at': '2001-01-01T00:00:00Z' })
    expect(newer.stderr).toContain('this CLI is newer than the server')
  })

  it('is neutral when nothing can order them', async () => {
    const { stderr } = await warn({ 'x-croft-version': await release(), 'x-croft-cli': '0123456789abcdef' })
    expect(stderr).toContain('CLI and server differ')
  })

  it('names the scheduled job when this machine has one', async () => {
    const { base } = await serve({ 'x-croft-version': '99.0.0' })
    const home = await homeWith('CROFT_API_KEY=croft_only')
    await mkdir(join(home, '.croft/maintenance'), { recursive: true })
    await writeFile(join(home, '.croft/maintenance/install-cron.mjs'), '')
    const agent = join(home, 'Library/LaunchAgents/com.croft.agent-files.plist')
    await mkdir(dirname(agent), { recursive: true })
    await writeFile(agent, '')
    const { stderr } = await run('node', [CLI, 'projects'], { PATH: BASE_PATH, HOME: home, CROFT_BASE_URL: base })
    expect(stderr).toContain(
      process.platform === 'darwin'
        ? 'launchctl kickstart gui/'
        : `node ${join(home, '.croft/maintenance/install-cron.mjs')} --run agent-files`,
    )
  })

  it('--version says it once', async () => {
    const { stdout, stderr } = await warn({ 'x-croft-version': '99.0.0' }, ['--version'])
    expect(stdout).toContain('server 99.0.0')
    expect(stderr.match(/older than the server/g)).toHaveLength(1)
  })

  it('reads install time from the file itself', async () => {
    // A copy whose mtime is older than the build: the Mac after a merge.
    const dir = await temp('croft-wiring-copy-')
    const copy = join(dir, 'croft.mjs')
    await writeFile(copy, `${await readFile(CLI, 'utf8')}\n// drifted\n`)
    await utimes(copy, new Date('2001-01-01'), new Date('2001-01-01'))
    const { base } = await serve({
      'x-croft-version': await release(),
      'x-croft-cli': '0123456789abcdef',
      'x-croft-built-at': '2020-01-01T00:00:00Z',
    })
    const home = await homeWith('CROFT_API_KEY=croft_only')
    const { stderr } = await run('node', [copy, 'projects'], { PATH: BASE_PATH, HOME: home, CROFT_BASE_URL: base })
    expect(stderr).toContain('this CLI is older than the server')
  })
})

describe('the installer: one SessionStart hook, and nothing it used to write', () => {
  const READ_HOOK = (prefix = '') => ({
    matcher: 'Read',
    hooks: [{ type: 'command', command: `${prefix}node /old/home/.croft/hooks/croft-context.mjs`, async: true, timeout: 10 }],
  })
  const OLD = (script: string, extra = '') => ({ type: 'command', command: `node /old/.croft/hooks/${script}${extra}`, 'croft-memory': true })

  it('takes out its own retired hooks, keeps everyone else’s, installs SessionStart, and is idempotent', async () => {
    const home = await temp('croft-wiring-hooks-')
    await mkdir(join(home, '.claude'))
    await mkdir(join(home, '.codex'))
    const foreignPre = { type: 'command', command: '/someone/else/pre.sh' }
    await writeFile(
      join(home, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Read', hooks: [READ_HOOK().hooks[0], foreignPre] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: '/guard.sh' }] },
          ],
          SessionEnd: [{ hooks: [OLD('croft-session-end.mjs')] }],
          PreCompact: [{ hooks: [OLD('croft-session-end.mjs')] }],
          Stop: [{ hooks: [OLD('croft-learn-nudge.mjs')] }],
        },
      }),
    )
    const quarry = { type: 'command', command: 'node /x/.quarry/hooks/quarry-session-end.mjs' }
    await writeFile(
      join(home, '.codex/hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [READ_HOOK('CROFT_AGENT=codex ')],
          Stop: [{ hooks: [quarry] }, { hooks: [OLD('croft-session-end.mjs', ' --ongoing')] }],
          SessionEnd: [{ hooks: [OLD('croft-session-end.mjs')] }],
        },
      }),
    )

    const env = { PATH: BASE_PATH, HOME: home, CROFT_OPENCLAW_BIN: 'openclaw-not-installed' }
    const first = await run('node', ['scripts/install-hooks.mjs'], env)
    expect(first.code, first.stderr).toBe(0)

    const claude = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))
    expect(claude.hooks.PreToolUse).toEqual([
      { matcher: 'Read', hooks: [foreignPre] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/guard.sh' }] },
    ])
    expect(Object.keys(claude.hooks).sort()).toEqual(['PreToolUse', 'SessionStart'])
    expect(claude.hooks.SessionStart).toEqual([
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [expect.objectContaining({ command: `node ${join(home, '.croft/hooks/croft-context.mjs')}`, 'croft-memory': true })],
      },
    ])

    const codex = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
    expect(codex.hooks.PreToolUse).toBeUndefined()
    expect(codex.hooks.SessionEnd).toBeUndefined()
    // Somebody else's hook: warned about, never removed.
    expect(codex.hooks.Stop).toEqual([{ hooks: [quarry] }])
    expect(first.stdout).toContain('Stop (runs every turn): node /x/.quarry/hooks/quarry-session-end.mjs')
    const start = codex.hooks.SessionStart.flatMap((g: { hooks: { command: string }[] }) => g.hooks)
    expect(start).toEqual([expect.objectContaining({ command: expect.stringMatching(/^CROFT_AGENT=codex .*croft-context\.mjs$/), 'croft-memory': true })])
    expect(first.stdout).toContain("removed Croft's old")

    const second = await run('node', ['scripts/install-hooks.mjs'], env)
    expect(second.code, second.stderr).toBe(0)
    expect(second.stdout).toContain(`${join(home, '.claude/settings.json')} — unchanged`)
    expect(second.stdout).toContain(`${join(home, '.codex/hooks.json')} — unchanged`)
  })

  it('yields to Cairn: no Croft briefing where Cairn\'s SessionStart hook is installed', async () => {
    const home = await temp('croft-wiring-cairn-')
    await mkdir(join(home, '.claude'))
    await mkdir(join(home, '.codex'))
    const cairn = { type: 'command', command: 'node /h/.cairn/hooks/cairn-context.mjs', 'cairn-memory': true, timeout: 10 }
    await writeFile(
      join(home, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: 'startup|resume|clear|compact', hooks: [cairn] },
            // A Croft entry from before Cairn was installed: taken out.
            { matcher: 'startup', hooks: [OLD('croft-context.mjs')] },
          ],
        },
      }),
    )
    // Codex has no Cairn here, so Croft briefs it.
    await writeFile(join(home, '.codex/hooks.json'), JSON.stringify({ hooks: {} }))

    const env = { PATH: BASE_PATH, HOME: home, CROFT_OPENCLAW_BIN: 'openclaw-not-installed' }
    const out = await run('node', ['scripts/install-hooks.mjs'], env)
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('claude: briefing: carried by Cairn')
    expect(out.stdout).not.toContain('codex: briefing: carried by Cairn')

    const claude = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))
    expect(claude.hooks.SessionStart).toEqual([{ matcher: 'startup|resume|clear|compact', hooks: [cairn] }])
    const codex = JSON.parse(await readFile(join(home, '.codex/hooks.json'), 'utf8'))
    expect(codex.hooks.SessionStart[0].hooks).toEqual([expect.objectContaining({ 'croft-memory': true })])

    // And a re-run still says so, without touching the file.
    const again = await run('node', ['scripts/install-hooks.mjs'], env)
    expect(again.stdout).toContain('claude: briefing: carried by Cairn')
    expect(again.stdout).toContain(`${join(home, '.claude/settings.json')} — unchanged`)
  })

  it('installs its own tagged SessionStart entry where Cairn is absent', async () => {
    const home = await temp('croft-wiring-nocairn-')
    await mkdir(join(home, '.claude'))
    await writeFile(join(home, '.claude/settings.json'), JSON.stringify({ hooks: {} }))
    const out = await run('node', ['scripts/install-hooks.mjs'], {
      PATH: BASE_PATH, HOME: home, CROFT_OPENCLAW_BIN: 'openclaw-not-installed',
    })
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).not.toContain('carried by Cairn')
    expect(out.stdout).toContain('claude: SessionStart')
    const claude = JSON.parse(await readFile(join(home, '.claude/settings.json'), 'utf8'))
    expect(claude.hooks.SessionStart[0].hooks[0]).toMatchObject({ 'croft-memory': true })
    expect(claude.hooks.SessionStart[0].hooks[0].command).toMatch(/croft-context\.mjs$/)
  })
})

describe('the Mac sync job', () => {
  const render = async (flag: string) => {
    const home = await temp('croft-wiring-cron-')
    const sync = join(home, 'sync.mjs')
    const cli = join(home, 'croft')
    await writeFile(sync, '')
    await writeFile(cli, '')
    return run('node', ['scripts/install-cron.mjs', flag], {
      PATH: BASE_PATH,
      HOME: home,
      CROFT_SYNC_SCRIPT: sync,
      CROFT_CLI_PATH: cli,
      CROFT_NODE_PATH: process.execPath,
      CROFT_LOG_DIR: home,
    })
  }

  const agentFilesPlist = (stdout: string) => {
    const start = stdout.indexOf('<string>com.croft.agent-files</string>')
    return stdout.slice(start, stdout.indexOf('</plist>', start))
  }

  it('runs at load and every quarter hour under launchd, so a wake is never an hour late', async () => {
    const { stdout } = await render('--launchd')
    const plist = agentFilesPlist(stdout)
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    for (const minute of [0, 15, 30, 45]) {
      expect(plist).toContain(`<key>Minute</key><integer>${minute}</integer>`)
    }
    expect(plist).not.toContain('<key>StartInterval</key>')
    // Nothing else changed: the other jobs still wait for their slot.
    const reconcile = stdout.slice(stdout.indexOf('<string>com.croft.reconcile</string>'))
    expect(reconcile.slice(0, reconcile.indexOf('</plist>'))).toContain('<key>RunAtLoad</key><false/>')
  })

  it('leaves the server crontab hourly, where the deploy is the trigger', async () => {
    const { stdout } = await render('--cron')
    // Every value is single-quoted for the shell now (CROFT-... F2), so this
    // matches the rendered line rather than pinning its old unquoted shape.
    expect(stdout).toMatch(/^23 \* \* \* \* CROFT_AGENT='maintenance' .*sync\.mjs'/m)
  })
})

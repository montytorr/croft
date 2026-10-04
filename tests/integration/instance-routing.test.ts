import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Which instance a command goes to when it does not say (CROFT-297): the
 * directory's route, the session's answer, the default — and
 * otherwise nothing at all, with an instruction to ask.
 */
const cli = join(process.cwd(), 'cli', 'croft.mjs')

type Seen = { auth?: string; path?: string; body?: string }[]

const serve = (seen: Seen) =>
  new Promise<{ server: Server; url: string }>((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        seen.push({ auth: req.headers.authorization, path: req.url, body })
        if (req.method === 'GET' && req.url === '/api/v1/tasks/WORK-3') {
          res.end(JSON.stringify({ success: true, data: { project: { key: 'WORK' }, number: 3, title: 'work item' } }))
          return
        }
        res.end(JSON.stringify({ success: true, data: { id: 1, results: [], count: 0 } }))
      })
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }))
  })

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' })

describe('routing a command to its instance', () => {
  let home: string
  const servers: Server[] = []
  let a: string
  let b: string
  const seenA: Seen = []
  const seenB: Seen = []

  const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const merged: Record<string, string | undefined> = {
        ...process.env,
        HOME: home,
        CROFT_AGENT: 'claude-code',
        CROFT_DEADLINE_MS: '2000',
        NO_PROXY: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      }
      for (const k of ['CROFT_BASE_URL', 'CROFT_API_KEY', 'CROFT_INSTANCE', 'CROFT_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete merged[k]
      Object.assign(merged, env)
      const child = spawn(process.execPath, [cli, ...args], { cwd, env: merged as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    })

  const configure = async (extra: object = {}) => {
    await writeFile(join(home, '.croft', 'instances.json'), JSON.stringify({
      version: 1,
      instances: { personal: { url: a }, work: { url: b } },
      unclassified: { mode: 'ask' },
      ...extra,
    }))
    for (const [name, key] of [['personal', 'crn_personal'], ['work', 'crn_work']] as const) {
      await mkdir(join(home, '.croft', 'instances', name), { recursive: true })
      await writeFile(join(home, '.croft', 'instances', name, 'env'), `CROFT_API_KEY_CLAUDE_CODE=${key}\n`)
    }
  }

  const where = () => ({ personal: seenA.length, work: seenB.length })

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'croft-routing-')))
    await mkdir(join(home, '.croft'), { recursive: true })
    seenA.length = 0
    seenB.length = 0
    const first = await serve(seenA)
    const second = await serve(seenB)
    servers.push(first.server, second.server)
    a = first.url
    b = second.url
  })

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
    await rm(home, { recursive: true, force: true })
  })

  it('routes a repository, its subdirectories and its worktrees by the main checkout', async () => {
    await configure()
    const repo = join(home, 'code', 'client-site')
    await mkdir(join(repo, 'src'), { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'first')
    git(repo, 'worktree', 'add', '-q', join(home, 'code', 'client-site-wt'))

    const saved = await run(repo, ['route', 'add', 'work'])
    expect(saved.code).toBe(0)
    expect(saved.stdout).toContain('repository ~/code/client-site -> work')

    for (const cwd of [repo, join(repo, 'src'), join(home, 'code', 'client-site-wt')]) {
      expect((await run(cwd, ['note', 'ACME-1', 'x'])).code).toBe(0)
    }
    expect(where()).toEqual({ personal: 0, work: 3 })
  })

  it('does not let GIT_DIR say which repository this is', async () => {
    await configure()
    const client = join(home, 'client')
    const other = join(home, 'other')
    for (const dir of [client, other]) {
      await mkdir(dir, { recursive: true })
      git(dir, 'init', '-q')
    }
    await run(client, ['route', 'add', 'work'])
    const result = await run(other, ['note', 'ACME-1', 'x'], { GIT_DIR: join(client, '.git') })
    expect(result.code).toBe(10)
    expect(where()).toEqual({ personal: 0, work: 0 })
  })

  it('routes everything under a folder, lets an exact route override it, and refuses overlaps', async () => {
    await configure()
    const clients = join(home, 'clients')
    await mkdir(join(clients, 'acme', 'docs'), { recursive: true })
    await mkdir(join(clients, 'side-project'), { recursive: true })

    expect((await run(clients, ['route', 'add', 'work', '--folder'])).code).toBe(0)
    expect((await run(join(clients, 'side-project'), ['route', 'add', 'personal'])).code).toBe(0)

    await run(join(clients, 'acme', 'docs'), ['note', 'ACME-1', 'x'])
    await run(join(clients, 'side-project'), ['note', 'ACME-1', 'x'])
    expect(where()).toEqual({ personal: 1, work: 1 })

    const nested = await run(join(clients, 'acme'), ['route', 'add', 'personal', '--folder'])
    expect(nested.code).toBe(2)
    expect(nested.stderr).toContain('overlap')
  })

  it('refuses a folder route on the home directory, and offers none in the question', async () => {
    await configure()
    const refused = await run(home, ['route', 'add', 'personal', '--folder'])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('would classify everything under it')

    const asked = await run(home, ['note', 'ACME-1', 'x'])
    expect(asked.code).toBe(10)
    expect(asked.stderr).toContain('croft route add <instance>             this directory')
    expect(asked.stderr).not.toContain('--folder')
  })

  it('needs --force to change a saved answer', async () => {
    await configure()
    const dir = join(home, 'notes')
    await mkdir(dir)
    await run(dir, ['route', 'add', 'work'])
    const changed = await run(dir, ['route', 'add', 'personal'])
    expect(changed.code).toBe(2)
    expect(changed.stderr).toContain('--force')
    expect((await run(dir, ['route', 'add', 'personal', '--force'])).code).toBe(0)
    await run(dir, ['note', 'ACME-1', 'x'])
    expect(where()).toEqual({ personal: 1, work: 0 })
  })

  it('routes by --cwd, which is how a hook speaks for a session that ran elsewhere', async () => {
    await configure()
    const repo = join(home, 'repo')
    await mkdir(repo)
    await run(repo, ['route', 'add', 'work'])
    const result = await run(home, ['check', 'x', '--cwd', repo])
    expect(result.code).toBe(0)
    expect(where()).toEqual({ personal: 0, work: 1 })
  })

  it('routes a todo (T-n) and a subject (S-n) by the directory, never by the ref: every instance has T', async () => {
    await configure({ unclassified: { mode: 'default', instance: 'personal' } })
    expect((await run(home, ['note', 'T-41', 'x'])).code).toBe(0)
    expect((await run(home, ['subject', 'note', 'S-3', 'x'])).code).toBe(0)
    expect(where()).toEqual({ personal: 2, work: 0 })

    const repo = join(home, 'lab')
    await mkdir(repo)
    await run(repo, ['route', 'add', 'work'])
    expect((await run(repo, ['claim', 'T-41'])).code).toBe(0)
    expect(where()).toEqual({ personal: 2, work: 1 })
  })

  it('a ref follows the saved route or the default without consulting any instance', async () => {
    await configure({ unclassified: { mode: 'default', instance: 'personal' } })
    expect((await run(home, ['show', 'T-41'])).code).toBe(0)
    // Only the request itself reached a server: no listing of projects to find an owner.
    expect(seenA.map((r) => r.path)).toEqual(['/api/v1/tasks/T-41?view=digest'])
    expect(where()).toEqual({ personal: 1, work: 0 })

    const repo = join(home, 'work-repo')
    await mkdir(repo)
    await run(repo, ['route', 'add', 'work'])
    expect((await run(repo, ['show', 'T-41'])).code).toBe(0)
    expect(seenB.map((r) => r.path)).toEqual(['/api/v1/tasks/T-41?view=digest'])
    expect(where()).toEqual({ personal: 1, work: 1 })

    await configure()
    expect((await run(home, ['show', 'T-41'])).code).toBe(10)
    expect(where()).toEqual({ personal: 1, work: 1 })
  })

  it('remembers a per-session answer for that session only', async () => {
    await configure()
    const saved = await run(home, ['route', 'add', 'work', '--session'], { CLAUDE_CODE_SESSION_ID: 'sess-1' })
    expect(saved.code).toBe(0)
    expect((await run(home, ['note', 'ACME-1', 'x'], { CLAUDE_CODE_SESSION_ID: 'sess-1' })).code).toBe(0)
    expect(where()).toEqual({ personal: 0, work: 1 })


    expect((await run(home, ['note', 'ACME-1', 'x'], { CLAUDE_CODE_SESSION_ID: 'sess-2' })).code).toBe(10)
  })

  it('refuses --session where no session id is known', async () => {
    await configure()
    const result = await run(home, ['route', 'add', 'work', '--session'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('needs a session id')
  })

  /** The reason's text is not the task: routing must read the command's own ref. */
  it('does not call --cwd ignored on a command it routed', async () => {
    await configure()
    const repo = join(home, 'routed')
    await mkdir(repo)
    await run(repo, ['route', 'add', 'work'])
    const result = await run(home, ['note', 'ACME-1', 'x', '--cwd', repo])
    expect(result.code).toBe(0)
    expect(where()).toEqual({ personal: 0, work: 1 })
    expect(result.stderr).not.toContain('does not take')
  })

  it('matches a hand-written route through a symlinked path', async () => {
    const real = join(home, 'real-dir')
    await mkdir(real)
    await symlink(real, join(home, 'linked'))
    await configure({ routes: [{ path: join(home, 'linked'), match: 'exact', instance: 'work' }] })
    expect((await run(real, ['note', 'ACME-1', 'x'])).code).toBe(0)
    expect(where()).toEqual({ personal: 0, work: 1 })
  })

  it('keeps keys it does not know when it rewrites instances.json', async () => {
    await configure({ note: 'hand-written' })
    const dir = join(home, 'd')
    await mkdir(dir)
    await run(dir, ['route', 'add', 'work'])
    expect(JSON.parse(await readFile(join(home, '.croft', 'instances.json'), 'utf8')).note).toBe('hand-written')
  })

  it('shows the route and why, lists routes, and never prints a key', async () => {
    await configure({ unclassified: { mode: 'default', instance: 'personal' } })
    const repo = join(home, 'r')
    await mkdir(repo)
    await run(repo, ['route', 'add', 'work'])

    const shown = await run(repo, ['route'])
    expect(shown.stdout).toContain('work')
    expect(shown.stdout).toContain('route ~/r')
    const byDefault = await run(home, ['route'])
    expect(byDefault.stdout).toContain('default instance')
    const list = await run(home, ['route', 'list'])
    expect(list.stdout).toContain('~/r')
    for (const out of [shown.stdout, byDefault.stdout, list.stdout]) expect(out).not.toContain('crn_')
    expect(await readFile(join(home, '.croft', 'instances.json'), 'utf8')).toContain('"match": "exact"')
  })
})

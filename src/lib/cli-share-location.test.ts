import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * CROFT_SHARE_LOCATION=off keeps a machine's layout on the machine: no
 * working directory, no git remote, no hostname in any request. Run from this
 * checkout, a git repository with a remote, so `context` would find both.
 */

const servers: Server[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { url: string; headers: IncomingHttpHeaders; body: string }

const serve = (seen: Seen[]) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, body })
        if (req.url?.startsWith('/api/v1/connect')) {
          // Refuse the pairing: the request body is all this test needs.
          res.writeHead(500, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ success: false, error: 'test' }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: {} }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string, extra: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'croft-location-'))
  directories.push(home)
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCLAW_|CROFT_|CAIRN_)/.test(name)) delete env[name]
  Object.assign(env, { HOME: home, CROFT_BASE_URL: base, CROFT_API_KEY: 'test-key', PATH: process.env.PATH }, extra)
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['cli/croft.mjs', ...args], { env: env as NodeJS.ProcessEnv })
    child.on('error', reject)
    child.on('close', resolve)
    child.stdin.end('')
  })
}

const leaks = (seen: Seen[]) =>
  seen.flatMap(({ url, headers }) => {
    const params = new URL(url, 'http://x').searchParams
    return [
      ...(params.has('cwd') ? [`cwd in ${url}`] : []),
      ...(params.has('repo') ? [`repo in ${url}`] : []),
      ...(headers['x-croft-host'] ? [`host header on ${url}`] : []),
    ]
  })

describe('CROFT_SHARE_LOCATION', () => {
  it('sends location by default, as before', async () => {
    const seen: Seen[] = []
    const base = await serve(seen)
    await run(['context', '--brief', '--cwd', '/tmp/repo'], base)
    await run(['context'], base)
    expect(leaks(seen).some((l) => l.startsWith('cwd'))).toBe(true)
  })

  it('the brief never sends the directory, even with location shared; context --cwd still does', async () => {
    const seen: Seen[] = []
    const base = await serve(seen)
    await run(['context', '--brief', '--cwd', '/tmp/repo'], base)
    const brief = seen.filter((s) => s.url.startsWith('/api/v1/subjects/brief'))
    expect(brief.length).toBe(1)
    expect(new URL(brief[0]!.url, 'http://x').searchParams.has('cwd')).toBe(false)

    await run(['context', '--cwd', '/tmp/repo'], base)
    const context = seen.find((s) => s.url.startsWith('/api/v1/context'))
    expect(new URL(context!.url, 'http://x').searchParams.get('cwd')).toBe('/tmp/repo')
  })

  it('off: no cwd, no repo, no hostname, for the brief and the full context', async () => {
    const seen: Seen[] = []
    const base = await serve(seen)
    await run(['context', '--brief', '--cwd', '/tmp/repo'], base, { CROFT_SHARE_LOCATION: 'off' })
    await run(['context'], base, { CROFT_SHARE_LOCATION: 'off' })
    await run(['subject', 'list'], base, { CROFT_SHARE_LOCATION: 'off' })
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(leaks(seen)).toEqual([])
  })

  it('off: pairing names the machine private-host, or the label someone chose', async () => {
    const pairingHost = async (extra: Record<string, string>) => {
      const seen: Seen[] = []
      const base = await serve(seen)
      await run(['setup', '--url', base, '--runtimes', 'claude-code', '--no-hooks', '--no-jobs', '--no-skill'], base, { CROFT_SHARE_LOCATION: 'off', ...extra })
      const connect = seen.find((s) => s.url.startsWith('/api/v1/connect'))
      return connect ? JSON.parse(connect.body).host : null
    }
    expect(await pairingHost({})).toBe('private-host')
    expect(await pairingHost({ CROFT_HOST: 'laptop-a' })).toBe('laptop-a')
  })

  it('off still sends a host label someone chose', async () => {
    const seen: Seen[] = []
    const base = await serve(seen)
    await run(['subject', 'list'], base, { CROFT_SHARE_LOCATION: 'off', CROFT_HOST: 'laptop-a' })
    expect(seen.some((s) => s.headers['x-croft-host'] === 'laptop-a')).toBe(true)
  })
})

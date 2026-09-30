import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)

describe('croft session checkpoint CLI', () => {
  it('sends an ongoing session with all requested fields, without closing or checkpointing held tasks', async () => {
    const received: unknown[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({ method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true, data: { id: 'one', endedAt: null, checkpointed: [] } }))
    })
    const home = mkdtempSync(join(tmpdir(), 'croft-session-cli-'))
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No test port')
      await exec('node', ['cli/croft.mjs', 'session', 'checkpoint', '--id', 'agent:example',
        '--platform', 'other', '--agent', 'example-agent', '--project', 'DEMO',
        '--cwd', '/work/demo', '--request', 'Feature work',
        '--completed', 'In progress', '--json'], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, CROFT_API_KEY: 'test-key',
          CROFT_BASE_URL: `http://127.0.0.1:${address.port}` },
      })
      expect(received).toEqual([{ method: 'POST', path: '/api/v1/sessions', body: {
        externalId: 'agent:example', platformSource: 'other', agentId: 'example-agent',
        project: 'DEMO', cwd: '/work/demo', request: 'Feature work',
        completed: 'In progress', files: [], taskRefs: [], ongoing: true, checkpointHeld: false,
      } }])
    } finally {
      server.close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

/**
 * CROFT-286: `session end` never resolved a project, and nothing else sent
 * one, so every live session landed unattributed. It now resolves the way
 * `croft context` does — the local map — and sends the checkout's remote so
 * the server can match it when the map has no entry.
 */
/** Without the markers of whatever runtime is running these tests. */
const runtimeFree = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCLAW_|CROFT_AGENT|CROFT_PLATFORM)/.test(name)),
  ) as NodeJS.ProcessEnv

describe('croft session end project attribution', () => {
  const capture = async (setup: (home: string, repo: string) => string[], env: Record<string, string> = {}) => {
    const received: { body: Record<string, unknown> }[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({ body: JSON.parse(Buffer.concat(chunks).toString()) })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: true, data: { id: 'one', checkpointed: [] } }))
    })
    const home = mkdtempSync(join(tmpdir(), 'croft-session-project-'))
    const repo = join(home, 'work', 'demo')
    try {
      mkdirSync(join(repo, 'src'), { recursive: true })
      await exec('git', ['init', '-q', repo])
      await exec('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:example/demo.git'])
      const args = setup(home, repo)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No test port')
      await exec('node', ['cli/croft.mjs', 'session', 'end', '--id', 's1', '--json', ...args], {
        cwd: process.cwd(), env: { ...runtimeFree(process.env), HOME: home, CROFT_API_KEY: 'test-key',
          CROFT_BASE_URL: `http://127.0.0.1:${address.port}`, ...env },
      })
      return received[0]?.body ?? {}
    } finally {
      server.close()
      rmSync(home, { recursive: true, force: true })
    }
  }

  const map = (home: string, entries: Record<string, string>) => {
    mkdirSync(join(home, '.croft'), { recursive: true })
    writeFileSync(join(home, '.croft', 'projects.json'), JSON.stringify(entries))
  }

  it('takes the project from the map, longest prefix, and sends the remote', async () => {
    const body = await capture((home, repo) => {
      map(home, { [join(home, 'work')]: 'WORK', [repo]: 'DEMO' })
      return ['--cwd', join(repo, 'src')]
    })
    expect(body.project).toBe('DEMO')
    expect(body.repo).toBe('git@github.com:example/demo.git')
  })

  it('sends the remote alone when the map has no entry, for the server to match', async () => {
    const body = await capture((_home, repo) => ['--cwd', repo])
    expect(body.project).toBeUndefined()
    expect(body.repo).toBe('git@github.com:example/demo.git')
  })

  it('keeps an explicit --project over the map', async () => {
    const body = await capture((home, repo) => {
      map(home, { [repo]: 'DEMO' })
      return ['--cwd', repo, '--project', 'OTHER']
    })
    expect(body.project).toBe('OTHER')
  })

  /**
   * CROFT-321: without --platform every manual `session end` was filed as
   * `claude`, so a Codex or OpenClaw agent following the skill's handoff wrote
   * a second row beside its hook's.
   */
  it('takes the platform from the runtime it runs in, unless told', async () => {
    const platform = async (env: Record<string, string>, args: string[] = []) =>
      (await capture((_home, repo) => ['--cwd', repo, ...args], env)).platformSource
    expect(await platform({})).toBe('claude')
    expect(await platform({ CROFT_AGENT: 'codex' })).toBe('codex')
    expect(await platform({ CROFT_AGENT: 'openclaw' })).toBe('openclaw')
    expect(await platform({ CROFT_AGENT: 'hermes' })).toBe('other')
    expect(await platform({ CROFT_AGENT: 'codex', CROFT_PLATFORM: 'openclaw' })).toBe('openclaw')
    expect(await platform({ CROFT_PLATFORM: 'hermes' })).toBe('other')
    expect(await platform({ CROFT_AGENT: 'codex' }, ['--platform', 'claude'])).toBe('claude')
  })
})

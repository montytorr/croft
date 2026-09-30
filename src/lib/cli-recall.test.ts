import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * `croft recall` and the summary `croft claim` prints (CROFT-268). The claim
 * half matters more: it is what reaches an agent that never thought to ask, so
 * it must appear when something bears on the task, stay silent when nothing
 * does, and never turn a successful claim into a failure.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const recall = {
  ref: 'BB-333',
  title: 'Ship the warm',
  decisions: [
    {
      ref: 'BB-343', title: 'Ladder', status: 'done', kind: 'finding',
      text: 'CONFLICT with BB-333: does NOT generalise to a warmed token', by: 'claude',
      at: '2026-09-14T12:20:00.000Z', why: ['names this task'],
    },
  ],
  knowledge: [{ slug: 'warm-cookies-are-ip-bound', title: 'Warm cookies are IP-bound', stale: true, verified: false, why: ['learned on BB-343'] }],
  omitted: { decisions: 2, knowledge: 0 },
}

/** Answers by path; `recallBody` is what /recall returns, or a 404 when null. */
const serve = (recallBody: unknown) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url?.includes('/recall')) {
          if (recallBody === null) {
            res.writeHead(404, { 'content-type': 'application/json' })
            return res.end(JSON.stringify({ success: false, error: 'no route', code: 'not_found' }))
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ success: true, data: recallBody }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { ref: 'BB-333', status: 'doing' } }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string) => {
  const home = await mkdtemp(join(tmpdir(), 'croft-recall-'))
  directories.push(home)
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/croft.mjs', ...args], {
      env: { ...process.env, HOME: home, CROFT_BASE_URL: base, CROFT_API_KEY: 'test-key' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('croft recall', () => {
  it('prints each line with why it was picked, and what the limit cut', async () => {
    const { code, stdout } = await run(['recall', 'BB-333'], await serve(recall))
    expect(code).toBe(0)
    expect(stdout).toContain('BB-343  finding · names this task · claude · 2026-09-14  [done]')
    expect(stdout).toContain('CONFLICT with BB-333')
    expect(stdout).toContain('warm-cookies-are-ip-bound  [stale]')
    expect(stdout).toContain('learned on BB-343')
    expect(stdout).toContain('2 more decision(s) — croft recall BB-333 --limit 30')
  })
})

describe('croft claim', () => {
  it('says what bears on the task it just claimed', async () => {
    const { code, stderr } = await run(['claim', 'BB-333'], await serve(recall))
    expect(code).toBe(0)
    expect(stderr).toContain('bears on this — croft recall BB-333:')
    expect(stderr).toContain('BB-343 finding (names this task): CONFLICT with BB-333')
    expect(stderr).toContain('knowledge: warm-cookies-are-ip-bound [stale]')
  })

  it('says nothing when nothing does', async () => {
    const empty = { ...recall, decisions: [], knowledge: [] }
    const { code, stderr } = await run(['claim', 'BB-333'], await serve(empty))
    expect(code).toBe(0)
    expect(stderr).not.toContain('bears on this')
  })

  it('still succeeds against a server without recall', async () => {
    const { code, stderr } = await run(['claim', 'BB-333'], await serve(null))
    expect(code).toBe(0)
    expect(stderr).not.toContain('bears on this')
  })
})

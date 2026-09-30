import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * The lab verbs: subjects (S-n), their todos (T-n, the task verbs), the
 * pairing with Cairn, and the five-line briefing. Each case asserts what
 * reached the wire as well as what was printed.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method: string; path: string; body?: Record<string, unknown> }
type Answer = { status?: number; payload: unknown }
type Reply = (req: Seen) => unknown

/** `reply` returns data (wrapped as success), or an Answer to send as it is. */
const serve = (reply: Reply, seen: Seen[] = []) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const entry: Seen = { method: req.method ?? '', path: req.url ?? '' }
        if (raw) try { entry.body = JSON.parse(raw) } catch { /* not json */ }
        seen.push(entry)
        const out = reply(entry)
        const answer = out && typeof out === 'object' && 'payload' in out
          ? (out as Answer)
          : { status: 200, payload: { success: true, data: out } }
        res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
        res.end(typeof answer.payload === 'string' ? answer.payload : JSON.stringify(answer.payload))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const RUNTIME_MARKERS = /^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCLAW_|CROFT_|CAIRN_)/

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}

type RunOptions = { agent?: string; env?: Record<string, string | undefined>; key?: string | null; stdin?: string }

const run = async (args: string[], base: string, opts: RunOptions = {}) => {
  const home = await tempDir('croft-lab-')
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of Object.keys(env)) if (RUNTIME_MARKERS.test(name)) delete env[name]
  Object.assign(env, { HOME: home, CROFT_BASE_URL: base, PATH: '/usr/bin:/bin' })
  if (opts.key !== null) env.CROFT_API_KEY = opts.key ?? 'test-key'
  if (opts.agent) env.CROFT_AGENT = opts.agent
  Object.assign(env, opts.env ?? {})
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['cli/croft.mjs', ...args], { env: env as NodeJS.ProcessEnv })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(opts.stdin ?? '')
  })
}

const stage = (name: string, category = 'active', position = 1) => ({ id: name, name, color: '#888', category, position })

const subject = (over: Record<string, unknown> = {}) => ({
  id: 's1', ref: 'S-12', number: 12, title: 'pgvector for recall', stage: stage('exploring'),
  tags: [{ id: 't1', name: 'db', color: '#000', position: 0 }], owner: { id: 'u1', name: 'Cal' },
  conclusion: null, todos: { open: 2, done: 1 }, position: 0, actor_id: 'claude-code',
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-30T10:00:00Z', body: 'the write-up', concluded_at: null,
  ...over,
})

const posts = (seen: Seen[], suffix: string) => seen.filter((s) => s.method === 'POST' && s.path.endsWith(suffix))

describe('croft subject', () => {
  it('add sends the title, stage, every tag, owner and body, and prints a count-first row', async () => {
    const seen: Seen[] = []
    const base = await serve(() => subject(), seen)
    const { code, stdout } = await run(
      ['subject', 'add', 'pgvector for recall', '--stage', 'exploring', '--tag', 'db', '--tag', 'search,infra', '--owner', 'me', '--body', '-'],
      base,
      { stdin: '## why\n- recall is slow\n' },
    )
    expect(code).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/v1/subjects' })
    expect(seen[0]!.body).toEqual({
      title: 'pgvector for recall', stage: 'exploring', tags: ['db', 'search', 'infra'], owner: 'me', body: '## why\n- recall is slow',
    })
    const lines = stdout.trim().split('\n')
    expect(lines[0]).toBe('#1')
    expect(lines[1]).toBe('ref\tstage\ttodos\ttags\ttokens\ttitle')
    expect(lines[2]).toMatch(/^S-12\texploring\t2\/1\tdb\t~\d+\tpgvector for recall$/)
  })

  it('list passes its filters and prints one row per subject', async () => {
    const seen: Seen[] = []
    const base = await serve(() => [subject(), subject({ ref: 'S-13', title: 'Try Bun', stage: stage('to explore', 'planned', 0) })], seen)
    const { code, stdout } = await run(['subject', 'list', '--stage', 'exploring', '--tag', 'db', '--mine', '--all'], base)
    expect(code).toBe(0)
    const params = new URL(seen[0]!.path, base).searchParams
    expect(params.get('stage')).toBe('exploring')
    expect(params.get('tag')).toBe('db')
    expect(params.get('owner')).toBe('me')
    expect(params.get('archived')).toBe('1')
    expect(stdout.split('\n')[0]).toBe('#2')
    expect(stdout).toContain('S-13\tto explore\t2/1')
  })

  it('show is a digest: conclusion, open todos, clipped write-up, findings, and what was withheld', async () => {
    const notes = [
      { id: 'n1', kind: 'finding', note: 'HNSW recall is 0.97 at k=10', actor_type: 'agent', actor_id: 'codex', created_at: '2026-09-02T10:00:00Z' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, kind: 'note', note: `note ${i}`, actor_type: 'agent', actor_id: 'codex', created_at: `2026-09-1${i}T10:00:00Z` })),
    ]
    const todos = [
      { id: 'a', ref: 'T-41', number: 41, title: 'Benchmark HNSW', status: 'doing', claimed_by: 'codex', cairn_ref: null, cairn_status: null, updated_at: '' },
      { id: 'b', ref: 'T-42', number: 42, title: 'Ship the index', status: 'todo', claimed_by: null, cairn_ref: 'CAIRN-331', cairn_status: 'doing', updated_at: '' },
      { id: 'c', ref: 'T-40', number: 40, title: 'Read the paper', status: 'done', claimed_by: null, cairn_ref: null, cairn_status: null, updated_at: '' },
    ]
    const seen: Seen[] = []
    const base = await serve((req) => {
      if (req.path.endsWith('/notes')) return notes
      if (req.path.endsWith('/todos')) return todos
      return subject({ body: 'x'.repeat(2000), conclusion: 'Use pgvector with HNSW.' })
    }, seen)
    const { code, stdout, stderr } = await run(['subject', 'show', 's-12'], base)
    expect(code).toBe(0)
    expect(seen.map((s) => s.path).sort()).toEqual(['/api/v1/subjects/S-12', '/api/v1/subjects/S-12/notes', '/api/v1/subjects/S-12/todos'])
    expect(stdout).toContain('S-12  exploring  pgvector for recall')
    expect(stdout).toContain('Use pgvector with HNSW.')
    expect(stdout).toContain('todos: 2 open / 1 closed')
    expect(stdout).toContain('T-42  todo  Ship the index  [Cairn CAIRN-331 doing]')
    expect(stdout).not.toContain('Read the paper')
    expect(stdout).toContain('HNSW recall is 0.97')
    expect(stdout).not.toContain('note 0')
    expect(stdout).toContain('note 7')
    expect(stderr).toMatch(/withheld: 500B of write-up, 3 note\(s\) — croft subject show S-12 --full is ~\d+ tokens/)

    const full = await run(['subject', 'show', 'S-12', '--full'], base)
    expect(full.stdout).toContain('note 0')
    expect(full.stdout).toContain('Read the paper')
    expect(full.stderr).toBe('')
  })

  it('stage names the fix when the server wants a conclusion', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({
      status: 400,
      payload: { success: false, error: 'Entering "done" needs a conclusion', code: 'conclusion_required' },
    }), seen)
    const { code, stderr } = await run(['subject', 'stage', 'S-12', 'done'], base)
    expect(code).toBe(1)
    expect(seen[0]).toMatchObject({ method: 'PATCH', path: '/api/v1/subjects/S-12', body: { stage: 'done' } })
    expect(stderr).toContain('S-12 -> "done" needs a conclusion')
    expect(stderr).toContain('re-run with --conclusion')
  })

  it('stage sends the conclusion, from stdin with -', async () => {
    const seen: Seen[] = []
    const base = await serve(() => subject({ stage: stage('done', 'completed') }), seen)
    const { code, stdout } = await run(['subject', 'stage', 'S-12', 'done', '--conclusion', '-'], base, { stdin: 'Use it.\n' })
    expect(code).toBe(0)
    expect(seen[0]!.body).toEqual({ stage: 'done', conclusion: 'Use it.' })
    expect(stdout).toContain('S-12\tdone')
  })

  it('note posts to the subject with its kind, and refuses a kind subjects do not take', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({ id: 'n', kind: 'finding', note: 'x' }), seen)
    expect((await run(['subject', 'note', 'S-12', 'it scales', '--kind', 'finding'], base)).code).toBe(0)
    expect(posts(seen, '/api/v1/subjects/S-12/notes')[0]!.body).toEqual({ note: 'it scales', kind: 'finding' })

    const bad = await run(['subject', 'note', 'S-12', 'x', '--kind', 'stage'], base)
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('--kind must be one of note, finding, decision, attempt, handoff')
    expect(seen).toHaveLength(1)
  })

  it('tag adds and removes from the tags it has', async () => {
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET'
      ? subject({ tags: [{ name: 'db' }, { name: 'infra' }] })
      : subject()), seen)
    const { code } = await run(['subject', 'tag', 'S-12', '+search', '-infra'], base)
    expect(code).toBe(0)
    expect(seen.find((s) => s.method === 'PATCH')!.body).toEqual({ tags: ['db', 'search'] })
  })

  it('todo files a T-n under the subject and claims it for an agent, not for a person', async () => {
    const reply: Reply = (req) => (req.path.endsWith('/claim')
      ? { status: 'doing', claimed_by: 'codex' }
      : { id: 'a', ref: 'T-41', number: 41, title: 'Benchmark', status: 'todo', claimed_by: null })
    const seen: Seen[] = []
    const base = await serve(reply, seen)
    const agent = await run(['subject', 'todo', 'S-12', 'Benchmark', '--body', 'measure recall at k=10'], base, { agent: 'codex' })
    expect(agent.code).toBe(0)
    expect(posts(seen, '/api/v1/subjects/S-12/todos')[0]!.body).toEqual({ title: 'Benchmark', description: 'measure recall at k=10' })
    expect(posts(seen, '/api/v1/tasks/T-41/claim')).toHaveLength(1)
    expect(agent.stdout).toContain('T-41\tdoing\tcodex')

    const person: Seen[] = []
    const again = await serve(reply, person)
    await run(['subject', 'todo', 'S-12', 'Benchmark'], again)
    expect(posts(person, '/claim')).toHaveLength(0)
  })

  it('refuses a ref that is not a subject, and says what a T-n is', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({}), seen)
    const { code, stderr } = await run(['subject', 'show', 'T-41'], base)
    expect(code).toBe(1)
    expect(stderr).toContain('T-41 is a todo')
    expect(seen).toHaveLength(0)
  })
})

describe('todo refs and subject refs on the task verbs', () => {
  it('T-41 is a task ref everywhere: show, claim, note, done', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({ ref: 'T-41', number: 41, status: 'doing', title: 'x' }), seen)
    for (const args of [['show', 'T-41'], ['claim', 'T-41'], ['note', 'T-41', 'x'], ['done', 'T-41', '--resolution', 'r']]) {
      expect((await run(args, base)).code).toBe(0)
    }
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /api/v1/tasks/T-41?view=digest',
      'POST /api/v1/tasks/T-41/claim',
      'POST /api/v1/tasks/T-41/notes',
      'PATCH /api/v1/tasks/T-41',
    ])
  })

  it('show S-12 shows the subject; claim S-12 says a subject is not a todo', async () => {
    const seen: Seen[] = []
    const base = await serve((req) => (req.path.endsWith('/notes') || req.path.endsWith('/todos') ? [] : subject()), seen)
    const shown = await run(['show', 'S-12'], base)
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain('S-12  exploring  pgvector for recall')
    expect(seen.some((s) => s.path.startsWith('/api/v1/tasks'))).toBe(false)

    const before = seen.length
    const claimed = await run(['claim', 'S-12'], base)
    expect(claimed.code).toBe(1)
    expect(claimed.stderr).toContain('S-12 is a subject, not a todo')
    expect(seen).toHaveLength(before)
  })

  it('a single-letter project key is a key', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({ key: 'L', title: 'Lab' }), seen)
    expect((await run(['project', 'create', 'L', 'Lab'], base)).code).toBe(0)
    expect(seen[0]!.body).toMatchObject({ key: 'L' })
  })
})

describe('croft check', () => {
  it('prints subject rows with their stage, and any kind it does not know as it came', async () => {
    const base = await serve(() => ({
      results: [
        { kind: 'subject', ref: 'S-12', stage: 'exploring', title: 'pgvector for recall', tokens: 120, conclusion: null },
        { kind: 'task', ref: 'T-41', status: 'doing', type: 'spike', title: 'Benchmark', tokens: 80 },
        { kind: 'widget', ref: 'W-1', status: { name: 'odd' }, title: 'Something\twith a tab' },
      ],
    }))
    const { code, stdout } = await run(['check', 'pgvector'], base)
    expect(code).toBe(0)
    const lines = stdout.trim().split('\n')
    expect(lines[0]).toBe('#3')
    expect(lines[1]).toBe('kind\tref\tstatus\ttype\tanswered\ttokens\ttitle')
    expect(lines[2]).toBe('subject\tS-12\texploring\t\t\t~120\tpgvector for recall')
    expect(lines[4]).toBe('widget\tW-1\todd\t\t\t\tSomething with a tab')
  })
})

/** A stand-in for Cairn's CLI: records its argv and stdin, answers like `cairn add` / `cairn show --json`. */
const fakeCairn = async (dir: string) => {
  const bin = join(dir, 'cairn.mjs')
  await writeFile(bin, `
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
let input = ''
try { input = readFileSync(0, 'utf8') } catch {}
appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify({ args, input }) + '\\n')
if (args[0] === 'add') {
  process.stderr.write('claimed nothing\\n')
  console.log('id\\tabc')
  console.log('ref\\tCAIRN-331')
  console.log('title\\t' + args[1])
} else if (args[0] === 'show') {
  console.log(JSON.stringify({ ref: args[1], status: args[1] === 'CAIRN-331' ? 'done' : 'doing', resolution: 'shipped' }))
}
`)
  const calls = async () => (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  return { bin, calls }
}

describe('croft push --to', () => {
  const todo = { id: 'a', number: 41, project: { key: 'T' }, title: 'Ship the index', type: 'spike', description: 'Build it behind a flag.', subject: { ref: 'S-12' } }

  it('files the todo in Cairn with its label and body, then records the link', async () => {
    const dir = await tempDir('croft-cairn-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET' ? todo : { cairn_ref: 'CAIRN-331' }), seen)
    const { code, stdout, stderr } = await run(['push', 'T-41', '--to', 'CAIRN'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code, stderr).toBe(0)
    const [call] = await cairn.calls()
    expect(call.args).toEqual(['add', 'Ship the index', '--project', 'CAIRN', '--type', 'spike', '--label', 'croft:T-41', '--body', '-', '--no-start'])
    expect(call.input).toBe('Build it behind a flag.\n\nFrom Croft T-41 (subject S-12)')
    expect(posts(seen, '/api/v1/tasks/T-41/cairn-link')[0]!.body).toEqual({ cairnRef: 'CAIRN-331' })
    expect(stdout).toContain('T-41\tCAIRN-331\tS-12\tShip the index')
    expect(stderr).toContain('Cairn owns its status from here')
  })

  it('says plainly when there is no cairn CLI, and files nothing', async () => {
    const seen: Seen[] = []
    const base = await serve(() => todo, seen)
    const { code, stderr } = await run(['push', 'T-41', '--to', 'CAIRN'], base)
    expect(code).toBe(1)
    expect(stderr).toContain('`cairn` is not in ~/.local/bin or on PATH')
    expect(stderr).toContain('CROFT_CAIRN_BIN')
    expect(seen).toHaveLength(0)
  })

  it('refuses a todo that is already paired', async () => {
    const dir = await tempDir('croft-cairn-')
    const cairn = await fakeCairn(dir)
    const base = await serve(() => ({ ...todo, cairn_ref: 'CAIRN-300' }))
    const { code, stderr } = await run(['push', 'T-41', '--to', 'CAIRN'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code).toBe(1)
    expect(stderr).toContain('T-41 is already paired with CAIRN-300')
  })

  it('without --to still records a git push', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({ event: 'git_push' }), seen)
    expect((await run(['push', 'T-41', 'abc1234'], base)).code).toBe(0)
    expect(posts(seen, '/api/v1/tasks/T-41/activity')[0]!.body).toEqual({ event: 'git_push', sha: 'abc1234' })
  })
})

describe('croft sync', () => {
  it('asks the server when it has a Cairn connection', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({ results: [{ ref: 'T-41', cairnRef: 'CAIRN-331', cairnStatus: 'done', result: 'noted' }] }), seen)
    const { code, stdout } = await run(['sync'], base)
    expect(code).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/v1/integrations/cairn/sync' })
    expect(stdout).toContain('T-41\tCAIRN-331\tdone\tnoted')
  })

  it('syncs through the local cairn CLI when the server has no connection', async () => {
    const dir = await tempDir('croft-cairn-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const base = await serve((req) => {
      if (req.path === '/api/v1/integrations/cairn/sync') {
        return { status: 409, payload: { success: false, error: 'No Cairn connection is configured', code: 'cairn_not_configured' } }
      }
      if (req.path.startsWith('/api/v1/projects/T/tasks')) {
        return {
          tasks: [
            { number: 41, project: { key: 'T' }, cairn_ref: 'CAIRN-331', cairn_status: 'doing' },
            { number: 42, project: { key: 'T' }, cairn_ref: 'CAIRN-332', cairn_status: 'doing' },
            { number: 43, project: { key: 'T' }, cairn_ref: null, cairn_status: null },
          ],
        }
      }
      return {}
    }, seen)
    const { code, stdout, stderr } = await run(['sync'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code, stderr).toBe(0)
    expect(stderr).toContain('syncing through this machine')
    expect((await cairn.calls()).map((c) => c.args)).toEqual([['show', 'CAIRN-331', '--json'], ['show', 'CAIRN-332', '--json']])
    expect(posts(seen, '/cairn-link').map((s) => [s.path, s.body])).toEqual([
      ['/api/v1/tasks/T-41/cairn-link', { cairnRef: 'CAIRN-331', cairnStatus: 'done' }],
    ])
    expect(stdout).toContain('T-41\tCAIRN-331\tdone\twas doing')
    expect(stdout).toContain('T-42\tCAIRN-332\tdoing\tunchanged')
  })
})

describe('croft context --brief', () => {
  const stages = [stage('to explore', 'planned', 0), stage('exploring', 'active', 1), stage('done', 'completed', 2), stage('implementing', 'active', 3)]

  it('is five lines at most: the lanes that are open, what is yours, and the rule', async () => {
    const seen: Seen[] = []
    const base = await serve((req) => (req.path === '/api/v1/stages'
      ? stages
      : {
          counts: { implementing: 1, exploring: 3, done: 40 },
          mine: [subject({ stage: stage('implementing') }), subject({ ref: 'S-13', title: 'Try Bun', todos: { open: 1, done: 0 } }), subject({ ref: 'S-14', todos: { open: 0, done: 0 } }), subject({ ref: 'S-15' })],
        }), seen)
    const { code, stdout, stderr } = await run(['context', '--brief', '--cwd', '/tmp/repo'], base)
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(new URL(seen.find((s) => s.path.startsWith('/api/v1/subjects/brief'))!.path, base).searchParams.get('cwd')).toBe('/tmp/repo')
    const lines = stdout.trimEnd().split('\n')
    expect(lines.length).toBeLessThanOrEqual(5)
    expect(lines[0]).toBe('Croft — lab: 3 exploring · 1 implementing')
    expect(lines[1]).toBe('  S-12 implementing  pgvector for recall — 2 todos')
    expect(lines[2]).toBe('  S-13 exploring  Try Bun — 1 todo')
    expect(lines[3]).toBe('  S-14 exploring  pgvector for recall')
    expect(lines[4]).toBe('Exploring or proving an idea → croft check first; changing a repo for real → a Cairn task (croft push).')
  })

  it('is silent, exit 0, when the lab has nothing open', async () => {
    const base = await serve((req) => (req.path === '/api/v1/stages' ? stages : { counts: { done: 4 }, mine: [] }))
    expect(await run(['context', '--brief'], base)).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('is silent, exit 0, when the server errors, answers garbage, or is not there', async () => {
    const failing = await serve(() => ({ status: 500, payload: { success: false, error: 'boom' } }))
    expect(await run(['context', '--brief'], failing)).toEqual({ code: 0, stdout: '', stderr: '' })

    const garbage = await serve(() => ({ status: 200, payload: '<html>not found</html>' }))
    expect(await run(['context', '--brief'], garbage)).toEqual({ code: 0, stdout: '', stderr: '' })

    expect(await run(['context', '--brief'], 'http://127.0.0.1:9')).toEqual({ code: 0, stdout: '', stderr: '' })
  })

  it('is silent, exit 0, when nothing is configured', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({ counts: { exploring: 1 }, mine: [] }), seen)
    expect(await run(['context', '--brief'], base, { key: null })).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(seen).toHaveLength(0)
  })
})

describe('the CLI surface', () => {
  it('reports its version', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'))
    const { code, stdout } = await run(['--version'], 'http://127.0.0.1:9')
    expect(code).toBe(0)
    expect(stdout.split('\n')[0]).toMatch(new RegExp(`^croft ${pkg.version.replace(/\./g, '\\.')}( [0-9a-f]{16})?$`))
  })

  it('offers the lab verbs and none of the memory verbs', async () => {
    const { stdout } = await run(['help'], 'http://127.0.0.1:9')
    for (const verb of ['croft subject add', 'croft subject stage', 'croft stages', 'croft tags', 'croft push T-41 --to', 'croft sync', 'croft context --brief']) {
      expect(stdout).toContain(verb)
    }
    for (const gone of ['croft learn', 'croft relearn', 'croft unlearn', 'croft verify', 'croft know', 'croft recall', 'croft vitals', 'croft session', 'croft entities']) {
      expect(stdout).not.toContain(gone)
    }
  })

  it('refuses the memory verbs as unknown commands', async () => {
    for (const verb of ['learn', 'know', 'recall', 'vitals', 'session']) {
      const { code, stderr } = await run([verb], 'http://127.0.0.1:9')
      expect(code).toBe(1)
      expect(stderr).toContain(`unknown command "${verb}"`)
    }
  })
})

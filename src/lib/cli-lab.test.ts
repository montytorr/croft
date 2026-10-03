import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
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

type Seen = { method: string; path: string; body?: Record<string, unknown>; raw?: string; contentType?: string }
type Answer = { status?: number; payload: unknown }
type Reply = (req: Seen) => unknown

/** `reply` returns data (wrapped as success), or an Answer to send as it is. */
const serve = (reply: Reply, seen: Seen[] = []) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const entry: Seen = { method: req.method ?? '', path: req.url ?? '', contentType: req.headers['content-type'] }
        if (raw) try { entry.body = JSON.parse(raw) } catch { entry.raw = raw }
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
    expect(lines[1]).toBe('ref\tstage\tvisibility\ttodos\ttags\tproject\ttokens\ttitle')
    expect(lines[2]).toMatch(/^S-12\texploring\tlab\t2\/1\tdb\t\t~\d+\tpgvector for recall$/)
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
    // `include`, not `1`: the server reads `1`/`true` as archived ONLY.
    expect(params.get('archived')).toBe('include')
    expect(stdout.split('\n')[0]).toBe('#2')
    expect(stdout).toContain('S-13\tto explore\tlab\t2/1')
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
      if (req.path.endsWith('/human-notes')) return [{ id: 'h1', body: 'Marc says per seat', author: { id: 'u1', name: 'Cal' } }]
      if (req.path.endsWith('/attachments')) return []
      if (req.path.endsWith('/notes')) return notes
      if (req.path.endsWith('/todos')) return todos
      return subject({ body: 'x'.repeat(2000), conclusion: 'Use pgvector with HNSW.' })
    }, seen)
    const { code, stdout, stderr } = await run(['subject', 'show', 's-12'], base)
    expect(code).toBe(0)
    expect(seen.map((s) => s.path).sort()).toEqual([
      '/api/v1/subjects/S-12', '/api/v1/subjects/S-12/attachments', '/api/v1/subjects/S-12/human-notes',
      '/api/v1/subjects/S-12/notes', '/api/v1/subjects/S-12/todos',
    ])
    // Counted, not printed: people's notes are read on purpose.
    expect(stdout).toContain("people's notes: 1 (croft subject notes S-12)")
    expect(stdout).not.toContain('Marc says per seat')
    expect(stdout).not.toContain('files:')
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

  it('show still works against a server with no people\'s notes or files', async () => {
    const base = await serve((req) => {
      if (req.path.endsWith('/human-notes') || req.path.endsWith('/attachments')) {
        return { status: 404, payload: { success: false, error: 'No route', code: 'not_found' } }
      }
      if (req.path.endsWith('/notes') || req.path.endsWith('/todos')) return []
      return subject()
    })
    const { code, stdout } = await run(['subject', 'show', 'S-12'], base)
    expect(code).toBe(0)
    expect(stdout).toContain('S-12  exploring  pgvector for recall')
    expect(stdout).not.toContain("people's notes")
  })

  it('notes prints people\'s notes with author, time and the whole body', async () => {
    const seen: Seen[] = []
    const base = await serve(() => [
      { id: 'h2', body: 'Licence is per seat.\n\n- ask Marc', author: { id: 'u1', name: 'Cal' },
        created_at: '2026-09-30T09:00:00Z', updated_at: '2026-09-30T10:30:00Z' },
      { id: 'h1', body: 'first', author: { id: 'u2', name: 'Ana' }, created_at: '2026-09-29T09:00:00Z', updated_at: '2026-09-29T09:00:00Z' },
    ], seen)
    const { code, stdout } = await run(['subject', 'notes', 'S-12'], base)
    expect(code).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/api/v1/subjects/S-12/human-notes' })
    expect(stdout).toContain('2026-09-30 09:00  Cal  (edited 2026-09-30 10:30)')
    expect(stdout).toContain('    - ask Marc')
    expect(stdout).toContain('2026-09-29 09:00  Ana\n    first')
  })

  it('attach uploads to the subject as multipart, HTML typed as text/html, and prints the file row', async () => {
    const dir = await tempDir('croft-attach-')
    const file = join(dir, 'report.html')
    await writeFile(file, '<h1>bench</h1>')
    const seen: Seen[] = []
    const base = await serve(() => ({
      id: 'f1', filename: 'report.html', mime_type: 'text/html', size_bytes: 14, kind: 'html', uploaded_by: 'claude-code',
      content_url: '/api/v1/attachments/f1/content', preview_url: '/api/files?x', download_url: '/api/files?y', created_at: '',
    }), seen)
    const { code, stdout } = await run(['subject', 'attach', 'S-12', file], base)
    expect(code).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/v1/subjects/S-12/attachments' })
    expect(seen[0]!.contentType).toMatch(/^multipart\/form-data/)
    expect(seen[0]!.raw).toContain('filename="report.html"')
    expect(seen[0]!.raw).toContain('Content-Type: text/html')
    expect(stdout).toContain('f1\treport.html\thtml\t14\tclaude-code\t/api/v1/attachments/f1/content')

    // `croft attach S-12 <file>` means the same; a todo's HTML goes up as text/html too.
    const again: Seen[] = []
    const base2 = await serve(() => ({ id: 'f2' }), again)
    expect((await run(['attach', 'S-12', file], base2)).code).toBe(0)
    expect(again[0]!.path).toBe('/api/v1/subjects/S-12/attachments')
    const todo: Seen[] = []
    const base3 = await serve(() => ({ id: 'f3' }), todo)
    expect((await run(['attach', 'T-41', file], base3)).code).toBe(0)
    expect(todo[0]!.path).toBe('/api/v1/tasks/T-41/attachments')
    expect(todo[0]!.raw).toContain('Content-Type: text/html')
  })

  it('attach names the embed for an image, and files lists the subject\'s files', async () => {
    const dir = await tempDir('croft-attach-')
    const file = join(dir, 'shot.png')
    await writeFile(file, 'png')
    const base = await serve((req) =>
      req.method === 'POST'
        ? { id: 'f1', filename: 'shot.png', kind: 'image', size_bytes: 3, uploaded_by: 'cal', content_url: '/api/v1/attachments/f1/content' }
        : [{ id: 'f1', filename: 'shot.png', kind: 'image', size_bytes: 3, uploaded_by: 'cal', content_url: '/api/v1/attachments/f1/content' }],
    )
    const attached = await run(['subject', 'attach', 'S-12', file], base)
    expect(attached.stderr).toContain('![shot.png](/api/v1/attachments/f1/content)')
    const listed = await run(['subject', 'files', 'S-12'], base)
    expect(listed.stdout.split('\n').slice(0, 3)).toEqual(['#1', 'id\tname\tkind\tbytes\tby\turl', 'f1\tshot.png\timage\t3\tcal\t/api/v1/attachments/f1/content'])
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

const trig = { id: 'p1', name: 'Trig', color: '#6b7fa6', cairn_key: 'TRIG', position: 0 }

describe('lab projects', () => {
  it('croft projects lists the lab projects with their Cairn key and subject count, in order', async () => {
    const seen: Seen[] = []
    const base = await serve(() => [
      { id: 'p2', name: 'Croft', color: '#888888', cairn_key: null, position: 1, subjects: 0 },
      { ...trig, subjects: 4 },
    ], seen)
    const { code, stdout } = await run(['projects'], base)
    expect(code).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/api/v1/lab-projects' })
    expect(stdout.split('\n').slice(0, 4)).toEqual(['#2', 'project\tcairn\tsubjects', 'Trig\tTRIG\t4', 'Croft\t\t0'])
  })

  it('project list is where the task containers went', async () => {
    const seen: Seen[] = []
    const base = await serve(() => [{ id: 'x', key: 'T', title: 'Todos', status: 'active', former_keys: [] }], seen)
    const { code, stdout } = await run(['project', 'list', '--archived'], base)
    expect(code).toBe(0)
    expect(seen[0]!.path).toBe('/api/v1/projects?archived=1')
    expect(stdout).toContain('T\tTodos')
  })

  it('subject add and list carry --project, and the row shows it', async () => {
    const seen: Seen[] = []
    const base = await serve(() => subject({ project: trig }), seen)
    const added = await run(['subject', 'add', 'pgvector for recall', '--project', 'Trig'], base)
    expect(added.code).toBe(0)
    expect(seen[0]!.body).toEqual({ title: 'pgvector for recall', project: 'Trig' })
    expect(added.stdout).toMatch(/\tdb\tTrig\t~\d+\tpgvector for recall/)

    const listed = await run(['subject', 'list', '--project', 'none'], base)
    expect(listed.code).toBe(0)
    expect(new URL(seen[1]!.path, base).searchParams.get('project')).toBe('none')
  })

  it('subject edit --project none takes it out of its project; a name puts it in one', async () => {
    const seen: Seen[] = []
    const base = await serve(() => subject(), seen)
    expect((await run(['subject', 'edit', 'S-12', '--project', 'none'], base)).code).toBe(0)
    expect((await run(['subject', 'edit', 'S-12', '--project', 'Trig'], base)).code).toBe(0)
    expect(seen.map((s) => s.body)).toEqual([{ project: null }, { project: 'Trig' }])
  })

  it('subject show prints the project and its Cairn key', async () => {
    const base = await serve((req) => (req.path.endsWith('/notes') || req.path.endsWith('/todos') ? [] : subject({ project: trig })))
    const { stdout } = await run(['subject', 'show', 'S-12'], base)
    expect(stdout).toContain('project Trig (Cairn TRIG)')
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

  it('renders the server\'s real /search payload: a concluded subject is answered, with its stage and tokens', async () => {
    // Shaped exactly as `unifiedResult` + `attachConclusions` in
    // src/app/api/v1/search/route.ts build it.
    const payload = {
      count: 3,
      query: 'pgvector',
      widened: false,
      results: [
        {
          kind: 'subject', ref: 'S-12', title: 'pgvector for recall', subtitle: 'Recall improved on the eval set.',
          project: null, type: 'subject', status: 'done', resolved: true, updatedAt: '2026-09-30T10:00:00Z',
          loose: false, tokens: 312,
          stage: 'done', conclusion: 'Recall improved on the eval set.',
        },
        {
          kind: 'subject', ref: 'S-14', title: 'pgvector on the read replica', subtitle: null,
          project: null, type: 'subject', status: 'exploring', resolved: false, updatedAt: '2026-09-29T10:00:00Z',
          loose: true, tokens: 0, stage: 'exploring', conclusion: null,
        },
        {
          kind: 'task', ref: 'T-41', title: 'Benchmark the index', subtitle: null, project: 'T', type: 'spike',
          status: 'doing', resolved: false, updatedAt: '2026-09-30T09:00:00Z', loose: false, tokens: 80,
        },
      ],
    }
    const base = await serve(() => payload)
    const { code, stdout, stderr } = await run(['check', 'pgvector'], base)
    expect(code).toBe(0)
    expect(stdout.trim().split('\n')).toEqual([
      '#3',
      'kind\tref\tstatus\ttype\tanswered\ttokens\ttitle',
      'subject\tS-12\tdone\tsubject\tyes\t~312\tpgvector for recall',
      'subject\tS-14\texploring\tsubject\t\t~0\tpgvector on the read replica',
      'task\tT-41\tdoing\tspike\t\t~80\tBenchmark the index',
    ])
    expect(stderr).toBe('2 precise, 1 loose\n')
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

  it('without --to files it under the Cairn key of its subject\'s lab project', async () => {
    const dir = await tempDir('croft-cairn-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const withKey = { ...todo, subject: { ref: 'S-12', project: { name: 'Trig', cairn_key: 'TRIG' } } }
    const base = await serve((req) => (req.method === 'GET' ? withKey : { cairn_ref: 'CAIRN-331' }), seen)
    const { code, stderr } = await run(['push', 'T-41'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code, stderr).toBe(0)
    const [call] = await cairn.calls()
    expect(call.args.slice(0, 4)).toEqual(['add', 'Ship the index', '--project', 'TRIG'])
    expect(stderr).toContain("filing in TRIG, Trig's Cairn project")
    expect(posts(seen, '/api/v1/tasks/T-41/cairn-link')).toHaveLength(1)

    // An explicit --to still wins.
    const again = await run(['push', 'T-41', '--to', 'OTHER'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(again.code, again.stderr).toBe(0)
    expect((await cairn.calls())[1].args.slice(0, 4)).toEqual(['add', 'Ship the index', '--project', 'OTHER'])
  })

  it('without --to refuses, saying what is missing, when there is no key to go to', async () => {
    const dir = await tempDir('croft-cairn-')
    const cairn = await fakeCairn(dir)
    const cases: [Record<string, unknown>, string][] = [
      [{ ...todo, subject: null }, 'T-41 is not part of a subject'],
      [{ ...todo, subject: { ref: 'S-12', project: null } }, "T-41's subject S-12 is in no lab project"],
      [{ ...todo, subject: { ref: 'S-12', project: { name: 'Trig', cairn_key: null } } }, "T-41's lab project Trig has no Cairn key"],
    ]
    for (const [shown, why] of cases) {
      const seen: Seen[] = []
      const base = await serve(() => shown, seen)
      const { code, stderr } = await run(['push', 'T-41'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
      expect(code).toBe(1)
      expect(stderr).toContain(why)
      expect(stderr).toContain('croft push T-41 --to <CAIRN_KEY>')
      expect(seen.map((s) => s.method)).toEqual(['GET'])
    }
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false)
  })

  it('without --to still records a git push', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({ event: 'git_push' }), seen)
    expect((await run(['push', 'T-41', 'abc1234'], base)).code).toBe(0)
    expect(posts(seen, '/api/v1/tasks/T-41/activity')[0]!.body).toEqual({ event: 'git_push', sha: 'abc1234' })
  })
})

describe('subject visibility', () => {
  const mael = { id: '5b0c9a52-7f6e-4b8e-9d1a-2f3e4d5c6b7a', name: 'Mael' }

  it('add sends visibility and every member, and says how to publish', async () => {
    const seen: Seen[] = []
    const base = await serve(() => subject({ visibility: 'members', members: [mael] }), seen)
    const { code, stdout, stderr } = await run(
      ['subject', 'add', 'pgvector for recall', '--visibility', 'members', '--member', 'mael@x.dev', '--member', 'sam,me'],
      base,
    )
    expect(code, stderr).toBe(0)
    expect(seen[0]!.body).toEqual({ title: 'pgvector for recall', visibility: 'members', members: ['mael@x.dev', 'sam', 'me'] })
    expect(stdout).toMatch(/^S-12\texploring\tmembers:1\t/m)
    expect(stderr).toContain('croft subject publish S-12 --confirm S-12 puts it in the lab (one-way)')
  })

  it('add refuses a --member without --visibility members, and an unknown visibility, before any request', async () => {
    const seen: Seen[] = []
    const base = await serve(() => subject(), seen)
    const members = await run(['subject', 'add', 'x', '--member', 'mael'], base)
    expect(members.code).toBe(1)
    expect(members.stderr).toContain('needs --visibility members')
    const bad = await run(['subject', 'add', 'x', '--visibility', 'secret'], base)
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('--visibility must be one of private, members, lab')
    expect(seen).toHaveLength(0)
  })

  it('list and show say who sees a subject', async () => {
    const base = await serve((req) =>
      req.path.startsWith('/api/v1/subjects?') || req.path === '/api/v1/subjects'
        ? [subject({ visibility: 'private', members: [] })]
        : req.path.endsWith('/notes') || req.path.endsWith('/todos')
          ? []
          : subject({ visibility: 'members', members: [mael] }),
    )
    const listed = await run(['subject', 'list'], base)
    expect(listed.stdout.split('\n')[2]).toMatch(/^S-12\texploring\tprivate\t/)
    const shown = await run(['subject', 'show', 'S-12'], base)
    expect(shown.stdout).toContain('shared with Mael')
  })

  it('share adds and removes people by whatever names them, and says when a private subject became shared', async () => {
    const seen: Seen[] = []
    let visibility = 'private'
    const base = await serve((req) => {
      if (req.method === 'POST') visibility = 'members'
      return subject({ visibility, members: [mael] })
    }, seen)
    const { code, stderr } = await run(['subject', 'share', 'S-12', '+sam@x.dev', '-Mael Dupont'], base)
    expect(code, stderr).toBe(0)
    const writes = seen.filter((s) => s.method !== 'GET').map((s) => [s.method, s.path, s.body])
    expect(writes).toEqual([
      ['POST', '/api/v1/subjects/S-12/members', { user: 'sam@x.dev' }],
      ['DELETE', '/api/v1/subjects/S-12/members/Mael%20Dupont', undefined],
    ])
    expect(stderr).toContain('it is now shared with its members')
  })

  it('share --visibility private makes it private again, and refuses a subject already in the lab', async () => {
    const seen: Seen[] = []
    const base = await serve(() => subject({ visibility: 'members', members: [mael] }), seen)
    expect((await run(['subject', 'share', 'S-12', '--visibility', 'private'], base)).code).toBe(0)
    expect(seen.filter((s) => s.method === 'PATCH').map((s) => s.body)).toEqual([{ visibility: 'private' }])

    const lab = await serve(() => subject({ visibility: 'lab', members: [] }))
    const refused = await run(['subject', 'share', 'S-12', '+mael'], lab)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('S-12 is in the lab')
    const toLab = await run(['subject', 'share', 'S-12', '--visibility', 'lab'], lab)
    expect(toLab.code).toBe(1)
    expect(toLab.stderr).toContain('croft subject publish S-12')
  })

  it('publish needs the ref confirmed and sends nothing without it', async () => {
    const seen: Seen[] = []
    const base = await serve(() => subject({ visibility: 'lab', members: [] }), seen)
    const { code, stderr } = await run(['subject', 'publish', 'S-12'], base)
    expect(code).toBe(1)
    expect(stderr).toContain('--confirm S-12')
    expect(posts(seen, '/api/v1/subjects/S-12/publish')).toHaveLength(0)
  })

  it('publish posts once and says it is one-way; a second publish is explained', async () => {
    const seen: Seen[] = []
    const base = await serve(() => subject({ visibility: 'lab', members: [] }), seen)
    const { code, stdout, stderr } = await run(['subject', 'publish', 'S-12', '--confirm', 'S-12'], base)
    expect(code, stderr).toBe(0)
    expect(posts(seen, '/api/v1/subjects/S-12/publish')).toHaveLength(1)
    expect(stdout).toMatch(/^S-12\texploring\tlab\t/m)
    expect(stderr).toContain('cannot be undone')

    const again = await serve(() => ({ status: 409, payload: { success: false, error: 'already in the lab', code: 'already_published' } }))
    const refused = await run(['subject', 'publish', 'S-12', '--confirm', 'S-12'], again)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('publishing is one-way')
  })

  it('push refuses a todo of an unpublished subject before Cairn is touched, and --force files and links it', async () => {
    const dir = await tempDir('croft-cairn-')
    const cairn = await fakeCairn(dir)
    const hidden = { id: 'a', number: 41, project: { key: 'T' }, title: 'Ship it', type: 'feature', description: 'x', subject: { ref: 'S-12', visibility: 'private' } }
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET' ? hidden : { cairn_ref: 'CAIRN-331' }), seen)

    const refused = await run(['push', 'T-41', '--to', 'CAIRN'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('S-12, which is private')
    expect(refused.stderr).toContain('--force')
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false)
    expect(seen.map((s) => s.method)).toEqual(['GET'])

    const forced = await run(['push', 'T-41', '--to', 'CAIRN', '--force'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(forced.code, forced.stderr).toBe(0)
    expect(posts(seen, '/api/v1/tasks/T-41/cairn-link')[0]!.body).toEqual({ cairnRef: 'CAIRN-331', force: true })
  })

  it('push --link carries --force, and names the fix when the server refuses', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({ status: 409, payload: { success: false, error: 'S-12 is not in the lab', code: 'subject_not_published' } }), seen)
    const refused = await run(['push', 'T-41', '--link', 'CAIRN-331'], base)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('re-run with --force')

    const ok = await serve(() => ({ cairn_ref: 'CAIRN-331' }), seen)
    expect((await run(['push', 'T-41', '--link', 'CAIRN-331', '--force'], ok)).code).toBe(0)
    expect(posts(seen, '/api/v1/tasks/T-41/cairn-link').at(-1)!.body).toEqual({ cairnRef: 'CAIRN-331', force: true })
  })
})

describe('croft sync', () => {
  it('rejects the retired server-only flag before sending a request', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({}), seen)
    const result = await run(['sync', '--server-only'], base)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--server-only')
    expect(seen).toHaveLength(0)
  })

  it('names the local setup needed when no Cairn CLI is installed', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({}), seen)
    const result = await run(['sync'], base)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('cairn setup --url <your Cairn>')
    expect(result.stderr).not.toContain('Settings')
    expect(seen).toHaveLength(0)
  })

  it('syncs through the local Cairn CLI without calling the retired integration', async () => {
    const dir = await tempDir('croft-cairn-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const base = await serve((req) => {
      if (req.path.startsWith('/api/v1/projects/T/tasks')) {
        // The list row's lab fields as the server adds them (TASK_LIST_LAB_FIELDS).
        const row = { status: 'todo', subject_ref: 'S-12' }
        return {
          count: 3,
          offset: 0,
          limit: 200,
          tasks: [
            { ...row, number: 41, project: { key: 'T' }, cairn_ref: 'CAIRN-331', cairn_status: 'doing' },
            { ...row, number: 42, project: { key: 'T' }, cairn_ref: 'CAIRN-332', cairn_status: 'doing' },
            { ...row, number: 43, project: { key: 'T' }, cairn_ref: null, cairn_status: null },
          ],
        }
      }
      if (req.path.endsWith('/cairn-link')) return { ref: 'T-41', status: 'done', noted: true, closed: true }
      return {}
    }, seen)
    const { code, stdout, stderr } = await run(['sync'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code, stderr).toBe(0)
    expect(seen.some((request) => request.path.startsWith('/api/v1/integrations/'))).toBe(false)
    expect((await cairn.calls()).map((c) => c.args)).toEqual([['show', 'CAIRN-331', '--json'], ['show', 'CAIRN-332', '--json']])
    expect(new URL(seen.find((s) => s.path.startsWith('/api/v1/projects/T/tasks'))!.path, base).searchParams.get('limit')).toBe('200')
    // The resolution travels, so the server writes `CAIRN-331 done: shipped` and closes the todo.
    expect(posts(seen, '/cairn-link').map((s) => [s.path, s.body])).toEqual([
      ['/api/v1/tasks/T-41/cairn-link', { cairnRef: 'CAIRN-331', cairnStatus: 'done', cairnResolution: 'shipped' }],
    ])
    expect(stdout).toContain('T-41\tCAIRN-331\tdone\twas doing · noted · closed')
    expect(stdout).toContain('T-42\tCAIRN-332\tdoing\tunchanged')
  })

  it('sends an ended Cairn task again while its todo is still open, so the server closes it', async () => {
    const dir = await tempDir('croft-cairn-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const base = await serve((req) => {
      if (req.path.startsWith('/api/v1/projects/T/tasks')) {
        return {
          count: 2,
          tasks: [
            // Status already recorded as done, todo still open: sent again.
            { number: 41, project: { key: 'T' }, status: 'todo', cairn_ref: 'CAIRN-331', cairn_status: 'done', subject_ref: 'S-12' },
            // Status recorded and the todo closed: nothing to do.
            { number: 44, project: { key: 'T' }, status: 'done', cairn_ref: 'CAIRN-331', cairn_status: 'done', subject_ref: 'S-12' },
          ],
        }
      }
      return { ref: 'T-41', status: 'done', noted: false, closed: true }
    }, seen)
    const { code, stdout, stderr } = await run(['sync'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code, stderr).toBe(0)
    expect(posts(seen, '/cairn-link').map((s) => s.path)).toEqual(['/api/v1/tasks/T-41/cairn-link'])
    expect(stdout).toContain('T-41\tCAIRN-331\tdone\tunchanged · closed')
    expect(stdout).toContain('T-44\tCAIRN-331\tdone\tunchanged')
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
    // The brief is not narrowed by directory, so the directory stays here.
    expect(seen.find((s) => s.path.startsWith('/api/v1/subjects/brief'))!.path).toBe('/api/v1/subjects/brief')
    const lines = stdout.trimEnd().split('\n')
    expect(lines.length).toBeLessThanOrEqual(5)
    expect(lines[0]).toBe('Croft — lab: 3 exploring · 1 implementing')
    expect(lines[1]).toBe('  S-12 implementing  pgvector for recall — 2 todos')
    expect(lines[2]).toBe('  S-13 exploring  Try Bun — 1 todo')
    expect(lines[3]).toBe('  S-14 exploring  pgvector for recall')
    expect(lines[4]).toBe('Exploring or proving an idea → croft check first; changing a repo for real → a Cairn task (croft push).')
  })

  it('reads the server\'s real /subjects/brief and /stages payloads', async () => {
    // As `subjectBrief` returns it: every stage by NAME, zeros included, and
    // SubjectSummary rows (no body, no concluded_at) with the stage as an object.
    const seeded = [
      ['to explore', 'planned'], ['exploring', 'active'], ['done', 'completed'], ['rejected', 'dropped'],
      ['to implement', 'planned'], ['implementing', 'active'], ['internal testing', 'active'],
      ['ready for rollout', 'active'], ['rolled out', 'completed'],
    ].map(([name, category], position) => ({
      id: `00000000-0000-4000-8000-00000000000${position}`, name, color: '#8a8792', category, position,
    }))
    const summary = (over: Record<string, unknown>) => {
      const { body: _body, concluded_at: _concluded, ...rest } = subject(over)
      return { ...rest, archived_at: null }
    }
    const brief = {
      counts: {
        'to explore': 0, exploring: 2, done: 5, rejected: 1, 'to implement': 1, implementing: 1,
        'internal testing': 0, 'ready for rollout': 0, 'rolled out': 3,
      },
      mine: [
        summary({ ref: 'S-20', number: 20, title: 'Streaming ingest', stage: seeded[5], todos: { open: 3, done: 1 } }),
        summary({ ref: 'S-21', number: 21, title: 'Try Bun', stage: seeded[4], todos: { open: 0, done: 0 } }),
      ],
    }
    const base = await serve((req) => (req.path === '/api/v1/stages' ? seeded : brief))
    const { code, stdout, stderr } = await run(['context', '--brief'], base)
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trimEnd().split('\n')).toEqual([
      // Stage order, open lanes only: completed and dropped ones are history.
      'Croft — lab: 2 exploring · 1 to implement · 1 implementing',
      '  S-20 implementing  Streaming ingest — 3 todos',
      '  S-21 to implement  Try Bun',
      'Exploring or proving an idea → croft check first; changing a repo for real → a Cairn task (croft push).',
    ])
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
    for (const verb of ['croft subject add', 'croft subject stage', 'croft stages', 'croft tags', 'croft projects', 'croft push T-41 [--to', 'croft sync', 'croft context --brief']) {
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

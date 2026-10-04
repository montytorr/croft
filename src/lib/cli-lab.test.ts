import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * The lab verbs: subjects (S-n), their todos (T-n, the task verbs), the
 * hand-offs to a task tracker, and the five-line briefing. Each case asserts what
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
      { id: 'a', ref: 'T-41', number: 41, title: 'Benchmark HNSW', status: 'doing', claimed_by: 'codex', handoff: null, updated_at: '' },
      { id: 'b', ref: 'T-42', number: 42, title: 'Ship the index', status: 'todo', claimed_by: null, handoff: { tracker: 'cairn', ref: 'CAIRN-331', url: null, status: 'doing', synced_at: null }, updated_at: '' },
      { id: 'c', ref: 'T-40', number: 40, title: 'Read the paper', status: 'done', claimed_by: null, handoff: null, updated_at: '' },
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
    expect(stdout).toContain('T-42  todo  Ship the index  [handed off cairn:CAIRN-331 doing]')
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

const trig = { id: 'p1', name: 'Trig', color: '#6b7fa6', handoff_tracker: 'cairn', handoff_target: 'TRIG', position: 0 }

describe('lab projects', () => {
  it('croft projects lists the lab projects with their hand-off and subject count, in order', async () => {
    const seen: Seen[] = []
    const base = await serve(() => [
      { id: 'p2', name: 'Croft', color: '#888888', handoff_tracker: null, handoff_target: null, position: 1, subjects: 0 },
      { ...trig, subjects: 4 },
    ], seen)
    const { code, stdout } = await run(['projects'], base)
    expect(code).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/api/v1/lab-projects' })
    expect(stdout.split('\n').slice(0, 4)).toEqual(['#2', 'project\thandoff\tsubjects', 'Trig\tcairn:TRIG\t4', 'Croft\t\t0'])
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

  it('subject show prints the project and its hand-off', async () => {
    const base = await serve((req) => (req.path.endsWith('/notes') || req.path.endsWith('/todos') ? [] : subject({ project: trig })))
    const { stdout } = await run(['subject', 'show', 'S-12'], base)
    expect(stdout).toContain('project Trig (hand-off cairn:TRIG)')
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
if (args[0] === 'add' && process.env.FAKE_REJECT_EXTERNAL && args.includes('--external-ref')) {
  process.stderr.write('error: unknown flag --external-ref\\n')
  process.exit(2)
}
if (args[0] === 'add' && process.env.FAKE_DUPLICATE) {
  process.stderr.write('already filed as CAIRN-331 (same --external-ref); nothing was created or claimed\\n')
  console.log('ref\\tCAIRN-331')
  console.log('duplicate\\ttrue')
  process.exit(0)
}
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

/** A stand-in for `gh`: issue 7 is closed as completed, 8 is open, 9 was closed as not planned. */
const fakeGh = async (dir: string) => {
  const bin = join(dir, 'gh.mjs')
  await writeFile(bin, `
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
let input = ''
try { input = readFileSync(0, 'utf8') } catch {}
appendFileSync(${JSON.stringify(join(dir, 'gh-calls.jsonl'))}, JSON.stringify({ args, input }) + '\\n')
if (args[0] === 'issue' && args[1] === 'create') {
  console.log('https://github.com/acme/app/issues/7')
} else if (args[0] === 'issue' && args[1] === 'view') {
  const n = args[2]
  const state = n === '8' ? 'OPEN' : 'CLOSED'
  const stateReason = n === '9' ? 'NOT_PLANNED' : n === '10' ? 'DUPLICATE' : n === '8' ? '' : 'COMPLETED'
  console.log(JSON.stringify({ state, stateReason, url: 'https://github.com/acme/app/issues/' + n }))
}
`)
  const calls = async () => (await readFile(join(dir, 'gh-calls.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  return { bin, calls }
}

describe('croft handoff', () => {
  const todo = { id: 'a', number: 41, project: { key: 'T' }, title: 'Ship the index', type: 'spike', description: 'Build it behind a flag.', subject: { ref: 'S-12' } }
  const linked = { handoff: { tracker: 'cairn', ref: 'CAIRN-331', url: null, status: 'todo', synced_at: null } }
  const hostOf = (base: string) => new URL(base).host

  it('files the todo through the adapter with an external ref, then records the link', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET' ? todo : linked), seen)
    const { code, stdout, stderr } = await run(['handoff', 'T-41', '--tracker', 'cairn', '--to', 'CAIRN'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code, stderr).toBe(0)
    const [call] = await cairn.calls()
    const url = `${base}/projects/T/tasks/41`
    expect(call.args).toEqual([
      'add', 'Ship the index', '--project', 'CAIRN', '--type', 'spike', '--body', '-', '--no-start',
      '--external-ref', `croft:${hostOf(base)}/T-41`, '--external-url', url,
    ])
    expect(call.input).toBe(`Build it behind a flag.\n\nFrom Croft T-41: ${url}`)
    expect(posts(seen, '/api/v1/tasks/T-41/handoff')[0]!.body).toEqual({ tracker: 'cairn', ref: 'CAIRN-331' })
    expect(stdout).toContain('T-41\tcairn\tCAIRN-331\tS-12\tShip the index')
    expect(stderr).toContain('cairn owns its status from here')
  })

  it('retries with a label when the installed cairn does not know external refs', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET' ? todo : linked), seen)
    const { code, stderr } = await run(['handoff', 'T-41', '--tracker', 'cairn', '--to', 'CAIRN'], base, {
      env: { CROFT_CAIRN_BIN: cairn.bin, FAKE_REJECT_EXTERNAL: '1' },
    })
    expect(code, stderr).toBe(0)
    const calls = await cairn.calls()
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toEqual([
      'add', 'Ship the index', '--project', 'CAIRN', '--type', 'spike', '--body', '-', '--no-start', '--label', 'croft:T-41',
    ])
    expect(posts(seen, '/api/v1/tasks/T-41/handoff')).toHaveLength(1)
  })

  it('files an issue through gh, with a footer back to the todo', async () => {
    const dir = await tempDir('croft-tracker-')
    const gh = await fakeGh(dir)
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET' ? todo : {}), seen)
    const { code, stderr } = await run(['handoff', 'T-41', '--tracker', 'github', '--to', 'acme/app'], base, { env: { CROFT_GH_BIN: gh.bin } })
    expect(code, stderr).toBe(0)
    const [call] = await gh.calls()
    expect(call.args).toEqual(['issue', 'create', '--repo=acme/app', '--title=Ship the index', '--body-file', '-'])
    expect(call.input).toBe(`Build it behind a flag.\n\n---\n\nFrom Croft T-41: ${base}/projects/T/tasks/41`)
    expect(posts(seen, '/api/v1/tasks/T-41/handoff')[0]!.body).toEqual({
      tracker: 'github', ref: 'acme/app#7', url: 'https://github.com/acme/app/issues/7',
    })
  })

  it('without flags goes where its subject\'s lab project says', async () => {
    const dir = await tempDir('croft-tracker-')
    const gh = await fakeGh(dir)
    const seen: Seen[] = []
    const project = { name: 'Trig', handoff_tracker: 'github', handoff_target: 'acme/app' }
    const base = await serve((req) => (req.method === 'GET' ? { ...todo, subject: { ref: 'S-12', project } } : {}), seen)
    const { code, stderr } = await run(['handoff', 'T-41'], base, { env: { CROFT_GH_BIN: gh.bin } })
    expect(code, stderr).toBe(0)
    expect(stderr).toContain("handing off to github acme/app, Trig's hand-off target")
    expect((await gh.calls())[0].args.slice(0, 3)).toEqual(['issue', 'create', '--repo=acme/app'])

    // An explicit --to still wins over the project's target.
    const again = await run(['handoff', 'T-41', '--to', 'acme/other'], base, { env: { CROFT_GH_BIN: gh.bin } })
    expect(again.code, again.stderr).toBe(0)
    expect((await gh.calls())[1].args.slice(0, 3)).toEqual(['issue', 'create', '--repo=acme/other'])
  })

  it('refuses, saying what is missing, when there is no target to go to', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const cases: [Record<string, unknown>, string][] = [
      [{ ...todo, subject: null }, 'T-41 is not part of a subject'],
      [{ ...todo, subject: { ref: 'S-12', project: null } }, "T-41's subject S-12 is in no lab project"],
      [{ ...todo, subject: { ref: 'S-12', project: { name: 'Trig', handoff_tracker: null, handoff_target: null } } }, "T-41's lab project Trig has no hand-off target"],
    ]
    for (const [shown, why] of cases) {
      const seen: Seen[] = []
      const base = await serve(() => shown, seen)
      // A machine with gh as well would ask which tracker first: pin the one under test.
      const { code, stderr } = await run(['handoff', 'T-41'], base, { env: { CROFT_CAIRN_BIN: cairn.bin, CROFT_TRACKER: 'cairn' } })
      expect(code).toBe(1)
      expect(stderr).toContain(why)
      expect(stderr).toContain('croft handoff T-41 --to <TARGET>')
      expect(seen.map((s) => s.method)).toEqual(['GET'])
    }
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false)
  })

  it('asks which tracker when two adapters are here, and files nothing', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const gh = await fakeGh(dir)
    const seen: Seen[] = []
    const base = await serve(() => todo, seen)
    const { code, stderr } = await run(['handoff', 'T-41', '--to', 'acme/app'], base, { env: { CROFT_CAIRN_BIN: cairn.bin, CROFT_GH_BIN: gh.bin } })
    expect(code).toBe(1)
    expect(stderr).toContain('which tracker?')
    expect(stderr).toContain('--tracker <name>')
    expect(stderr).toContain('CROFT_TRACKER')
    expect(seen.map((s) => s.method)).toEqual(['GET'])

    // CROFT_TRACKER answers it.
    const named = await run(['handoff', 'T-41', '--to', 'acme/app'], await serve((req) => (req.method === 'GET' ? todo : {})), {
      env: { CROFT_CAIRN_BIN: cairn.bin, CROFT_GH_BIN: gh.bin, CROFT_TRACKER: 'github' },
    })
    expect(named.code, named.stderr).toBe(0)
    expect((await gh.calls())[0].args[0]).toBe('issue')
  })

  it('uses the only adapter on the machine', async () => {
    const dir = await tempDir('croft-tracker-')
    const gh = await fakeGh(dir)
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET' ? todo : {}), seen)
    const { code, stderr } = await run(['handoff', 'T-41', '--to', 'acme/app'], base, { env: { CROFT_GH_BIN: gh.bin } })
    expect(code, stderr).toBe(0)
    expect(posts(seen, '/api/v1/tasks/T-41/handoff')[0]!.body).toMatchObject({ tracker: 'github' })
  })

  it('says plainly when the adapter\'s tool is missing, and files nothing', async () => {
    const seen: Seen[] = []
    const base = await serve(() => todo, seen)
    const { code, stderr } = await run(['handoff', 'T-41', '--tracker', 'cairn', '--to', 'CAIRN'], base)
    expect(code).toBe(1)
    expect(stderr).toContain('`cairn` is not in ~/.local/bin or on PATH')
    expect(stderr).toContain('CROFT_CAIRN_BIN')
    expect(seen.map((s) => s.method)).toEqual(['GET'])

    const unknown = await run(['handoff', 'T-41', '--tracker', 'linear', '--to', 'X'], base)
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('no adapter for "linear"')
    expect(unknown.stderr).toContain('--link <REF> --tracker linear')
  })

  it('refuses a todo that is already handed off', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const base = await serve(() => ({ ...todo, handoff: { tracker: 'cairn', ref: 'CAIRN-300', url: null, status: 'doing', synced_at: null } }))
    const { code, stderr } = await run(['handoff', 'T-41', '--tracker', 'cairn', '--to', 'CAIRN'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code).toBe(1)
    expect(stderr).toContain('T-41 is already handed off to cairn as CAIRN-300')
    expect(stderr).toContain('--undo')
  })

  it('--link records a task made by hand, for any tracker name, with its url', async () => {
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET' ? todo : {}), seen)
    const { code, stderr } = await run(['handoff', 'T-41', '--link', 'ENG-12', '--tracker', 'linear', '--url', 'https://linear.app/x/ENG-12', '--force'], base)
    expect(code, stderr).toBe(0)
    expect(posts(seen, '/api/v1/tasks/T-41/handoff')[0]!.body).toEqual({
      tracker: 'linear', ref: 'ENG-12', url: 'https://linear.app/x/ENG-12', force: true,
    })
    const bad = await run(['handoff', 'T-41', '--link', 'has space', '--tracker', 'linear'], base)
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('is not a task ref')
  })

  it('--undo takes it back with a DELETE and touches no tracker', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({ ref: 'T-41', status: 'todo', title: 'Ship the index', handoff: null }), seen)
    const { code, stdout, stderr } = await run(['handoff', 'T-41', '--undo'], base)
    expect(code, stderr).toBe(0)
    expect(seen.map((s) => [s.method, s.path])).toEqual([['DELETE', '/api/v1/tasks/T-41/handoff']])
    expect(stdout).toContain('T-41\ttodo\tShip the index')
    expect(stderr).toContain('T-41 is back in Croft')
  })

  it('refuses a todo of an unpublished subject before the tracker is touched, and --force hands it off', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const hidden = { ...todo, subject: { ref: 'S-12', visibility: 'private' } }
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET' ? hidden : linked), seen)
    const args = ['handoff', 'T-41', '--tracker', 'cairn', '--to', 'CAIRN']

    const refused = await run(args, base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('S-12, which is private')
    expect(refused.stderr).toContain('--force')
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false)
    expect(seen.map((s) => s.method)).toEqual(['GET'])

    const forced = await run([...args, '--force'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(forced.code, forced.stderr).toBe(0)
    expect(posts(seen, '/api/v1/tasks/T-41/handoff')[0]!.body).toEqual({ tracker: 'cairn', ref: 'CAIRN-331', force: true })
  })

  it('--link names the fix when the server refuses an unpublished subject', async () => {
    const base = await serve((req) => (req.method === 'GET'
      ? todo
      : { status: 409, payload: { success: false, error: 'S-12 is not in the lab', code: 'subject_not_published' } }))
    const refused = await run(['handoff', 'T-41', '--link', 'ENG-1', '--tracker', 'linear'], base)
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('re-run with --force')
  })

  it('prints the server\'s guidance when a hand-off was filed but refused', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const base = await serve((req) => (req.method === 'GET'
      ? todo
      : { status: 422, payload: { success: false, error: 'bad ref', code: 'validation_failed' } }))
    const { code, stderr } = await run(['handoff', 'T-41', '--tracker', 'cairn', '--to', 'CAIRN'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code).toBe(1)
    expect(stderr).toContain('CAIRN-331 was filed, but Croft refused the link: bad ref')
    expect(stderr).toContain('croft handoff T-41 --link CAIRN-331 --tracker cairn')
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
})

describe('croft sync', () => {
  const row = (number: number, handoff: Record<string, unknown> | null, status = 'todo') => ({
    number, project: { key: 'T' }, status, subject_ref: 'S-12', handoff,
  })
  const handoff = (tracker: string, ref: string, status: string | null = 'doing') => ({ tracker, ref, url: null, status, synced_at: null })
  const listing = (tasks: unknown[]) => (req: Seen) => (req.path.startsWith('/api/v1/projects/T/tasks') ? { count: tasks.length, offset: 0, limit: 200, tasks } : {})

  it('rejects the retired server-only flag before sending a request', async () => {
    const seen: Seen[] = []
    const base = await serve(() => ({}), seen)
    const result = await run(['sync', '--server-only'], base)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--server-only')
    expect(seen).toHaveLength(0)
  })

  it('reports and skips a todo whose tracker has no adapter here', async () => {
    const seen: Seen[] = []
    const base = await serve(listing([row(41, handoff('linear', 'ENG-12'))]), seen)
    const result = await run(['sync'], base)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('T-41\tlinear\tENG-12\tdoing\tskipped: no linear adapter on this machine')
    expect(posts(seen, '/handoff')).toHaveLength(0)
  })

  it('syncs each tracker through its own adapter, posting the outcome to /handoff', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const gh = await fakeGh(dir)
    const seen: Seen[] = []
    const base = await serve((req) => {
      if (req.path.endsWith('/handoff')) return { ref: 'T-41', status: 'done', noted: true, closed: true }
      return listing([
        row(41, handoff('cairn', 'CAIRN-331')),
        row(42, handoff('cairn', 'CAIRN-332')),
        row(43, null),
        row(44, handoff('github', 'acme/app#7', 'todo')),
        row(45, handoff('github', 'acme/app#8', 'todo')),
        row(46, handoff('github', 'acme/app#9', 'todo')),
      ])(req)
    }, seen)
    const { code, stdout, stderr } = await run(['sync'], base, { env: { CROFT_CAIRN_BIN: cairn.bin, CROFT_GH_BIN: gh.bin } })
    expect(code, stderr).toBe(0)
    expect((await cairn.calls()).map((c) => c.args)).toEqual([['show', 'CAIRN-331', '--json'], ['show', 'CAIRN-332', '--json']])
    expect((await gh.calls()).map((c) => c.args.slice(0, 4))).toEqual([
      ['issue', 'view', '7', '-R'], ['issue', 'view', '8', '-R'], ['issue', 'view', '9', '-R'],
    ])
    expect(new URL(seen.find((s) => s.path.startsWith('/api/v1/projects/T/tasks'))!.path, base).searchParams.get('limit')).toBe('200')
    // The resolution travels, so the server writes `CAIRN-331 done: shipped` and closes the todo.
    expect(posts(seen, '/handoff').map((s) => [s.path, s.body])).toEqual([
      ['/api/v1/tasks/T-41/handoff', { tracker: 'cairn', ref: 'CAIRN-331', status: 'done', resolution: 'shipped' }],
      ['/api/v1/tasks/T-44/handoff', { tracker: 'github', ref: 'acme/app#7', status: 'done', resolution: 'closed as completed', url: 'https://github.com/acme/app/issues/7' }],
      ['/api/v1/tasks/T-46/handoff', { tracker: 'github', ref: 'acme/app#9', status: 'cancelled', resolution: 'closed as not planned', resolutionKind: 'wont-fix', url: 'https://github.com/acme/app/issues/9' }],
    ])
    expect(stdout).toContain('ref\ttracker\thandoff\tstatus\tresult')
    expect(stdout).toContain('T-41\tcairn\tCAIRN-331\tdone\twas doing · noted · closed')
    expect(stdout).toContain('T-42\tcairn\tCAIRN-332\tdoing\tunchanged')
    expect(stdout).toContain('T-45\tgithub\tacme/app#8\ttodo\tunchanged')
  })

  it('sends an ended task again while its todo is still open, so the server closes it', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const base = await serve((req) => {
      if (req.path.endsWith('/handoff')) return { ref: 'T-41', status: 'done', noted: false, closed: true }
      return listing([
        // Status already recorded as done, todo still open: sent again.
        row(41, handoff('cairn', 'CAIRN-331', 'done'), 'todo'),
        // Status recorded and the todo closed: nothing to do.
        row(44, handoff('cairn', 'CAIRN-331', 'done'), 'done'),
      ])(req)
    }, seen)
    const { code, stdout, stderr } = await run(['sync'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code, stderr).toBe(0)
    expect(posts(seen, '/handoff').map((s) => s.path)).toEqual(['/api/v1/tasks/T-41/handoff'])
    expect(stdout).toContain('T-41\tcairn\tCAIRN-331\tdone\tunchanged · closed')
    expect(stdout).toContain('T-44\tcairn\tCAIRN-331\tdone\tunchanged')
  })

})

describe('croft context --brief', () => {
  const LAB_RULE = "Lab work (exploring, proving an idea, a subject's todos) → Croft: croft check first. Croft holds lab work only."
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
    expect(lines[4]).toBe(LAB_RULE)
  })

  it('adds the hand-off rule, on the same line, when a lab project has a target', async () => {
    const base = await serve((req) =>
      req.path === '/api/v1/stages'
        ? stages
        : req.path === '/api/v1/lab-projects'
          ? [{ id: 'p1', name: 'Trig', handoff_tracker: 'github', handoff_target: 'acme/app', subjects: 1 }]
          : { counts: { exploring: 1 }, mine: [] },
    )
    const { stdout } = await run(['context', '--brief'], base)
    expect(stdout.trimEnd().split('\n')).toEqual([
      'Croft — lab: 1 exploring',
      `${LAB_RULE} Committed work leaves the lab: croft handoff T-n.`,
    ])
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
      LAB_RULE,
    ])
  })

  it('is what bare `croft context` prints', async () => {
    const base = await serve((req) => (req.path === '/api/v1/stages' ? stages : { counts: { exploring: 1 }, mine: [] }))
    const bare = await run(['context'], base)
    expect(bare.code).toBe(0)
    expect(bare).toEqual(await run(['context', '--brief'], base))
    expect(bare.stdout).toContain('Croft — lab: 1 exploring')
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
    for (const verb of ['croft subject add', 'croft subject stage', 'croft stages', 'croft tags', 'croft projects', 'croft handoff T-41 [--to', 'croft handoff T-41 --undo', 'croft sync', 'croft claim T-41', 'croft done T-41', 'croft note T-41', 'croft checkpoint T-41', 'croft context --brief']) {
      expect(stdout).toContain(verb)
    }
    for (const gone of ['croft learn', 'croft relearn', 'croft unlearn', 'croft verify', 'croft know', 'croft recall', 'croft vitals', 'croft session', 'croft entities']) {
      expect(stdout).not.toContain(gone)
    }
  })

  it('keeps the other todo verbs under help --all, and every product name out of the short help', async () => {
    const short = (await run(['help'], 'http://127.0.0.1:9')).stdout
    const all = (await run(['help', '--all'], 'http://127.0.0.1:9')).stdout
    for (const verb of ['croft children', 'croft beat', 'croft labels', 'croft route add', 'croft reconcile', 'croft replay']) {
      expect(short).not.toContain(verb)
      expect(all).toContain(verb)
    }
    expect(all.startsWith(short.trimEnd())).toBe(true)
    expect(all).toContain('more todo verbs')
    // The product names live in the adapter section alone; help lists adapters from it.
    expect(short).toContain('adapters: cairn, github')
    expect(short).not.toMatch(/Cairn|CAIRN/)
  })

  it('refuses the verbs removed in 0.8 as unknown commands', async () => {
    for (const verb of ['next', 'deps', 'blockedby', 'unblockedby', 'commit', 'run', 'history', 'push', 'project', 'map']) {
      const { code, stderr } = await run([verb], 'http://127.0.0.1:9')
      expect(code).toBe(1)
      expect(stderr).toContain(`unknown command "${verb}"`)
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

describe('tracker adapters, defensively', () => {
  const todo = { id: 'a', number: 41, project: { key: 'T' }, title: '--project OTHER', type: 'chore', description: 'Body.', subject: { ref: 'S-12' } }
  const linked = { handoff: { tracker: 'cairn', ref: 'CAIRN-331', url: null, status: 'todo', synced_at: null } }

  it('keeps a title that starts with dashes from being read as a flag', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const base = await serve((req) => (req.method === 'GET' ? todo : linked))
    const { code, stderr } = await run(['handoff', 'T-41', '--tracker', 'cairn', '--to', 'CAIRN'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(code, stderr).toBe(0)
    const [call] = await cairn.calls()
    expect(call.args[1]).toBe('– project OTHER')
    expect(call.args.slice(2, 4)).toEqual(['--project', 'CAIRN'])
  })

  it('refuses to link the task an earlier hand-off filed, and links nothing', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const base = await serve((req) => (req.method === 'GET' ? { ...todo, title: 'Ship it' } : linked), seen)
    const { code, stderr } = await run(['handoff', 'T-41', '--tracker', 'cairn', '--to', 'CAIRN'], base, {
      env: { CROFT_CAIRN_BIN: cairn.bin, FAKE_DUPLICATE: '1' },
    })
    expect(code).toBe(1)
    expect(stderr).toContain('Cairn already has CAIRN-331 for T-41')
    expect(stderr).toContain('croft handoff T-41 --link CAIRN-331 --tracker cairn')
    expect(posts(seen, '/handoff')).toHaveLength(0)
  })

  it('reads a GitHub issue closed as a duplicate as cancelled, and never shows a ref that is not one', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const gh = await fakeGh(dir)
    const seen: Seen[] = []
    const tasks = [
      { number: 47, project: { key: 'T' }, status: 'todo', subject_ref: 'S-12', handoff: { tracker: 'github', ref: 'acme/app#10', url: null, status: 'todo', synced_at: null } },
      { number: 48, project: { key: 'T' }, status: 'todo', subject_ref: 'S-12', handoff: { tracker: 'cairn', ref: '--instance=evil', url: null, status: 'doing', synced_at: null } },
    ]
    const base = await serve((req) => {
      if (req.path.endsWith('/handoff')) return { ref: 'T-47', status: 'cancelled', noted: true, closed: true }
      return req.path.startsWith('/api/v1/projects/T/tasks') ? { count: tasks.length, offset: 0, limit: 200, tasks } : {}
    }, seen)
    const result = await run(['sync'], base, { env: { CROFT_CAIRN_BIN: cairn.bin, CROFT_GH_BIN: gh.bin } })
    expect(result.code, result.stderr).toBe(0)
    expect(posts(seen, '/api/v1/tasks/T-47/handoff')[0]!.body).toMatchObject({ status: 'cancelled', resolutionKind: 'duplicate' })
    expect(result.stdout).toContain('T-48\tcairn\t--instance=evil\tdoing\tunread: "--instance=evil" is not a Cairn task ref')
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false)
  })

  it('reports a todo the server refuses on its row, and goes on with the rest', async () => {
    const dir = await tempDir('croft-tracker-')
    const cairn = await fakeCairn(dir)
    const seen: Seen[] = []
    const tasks = [41, 42].map((number) => ({
      number, project: { key: 'T' }, status: 'todo', subject_ref: 'S-12',
      handoff: { tracker: 'cairn', ref: 'CAIRN-331', url: null, status: 'doing', synced_at: null },
    }))
    const base = await serve((req) => {
      if (req.path === '/api/v1/tasks/T-41/handoff') return { status: 409, payload: { success: false, error: 'refused for a reason', code: 'conflict' } }
      if (req.path.endsWith('/handoff')) return { ref: 'T-42', status: 'done', noted: true, closed: true }
      return req.path.startsWith('/api/v1/projects/T/tasks') ? { count: tasks.length, offset: 0, limit: 200, tasks } : {}
    }, seen)
    const result = await run(['sync'], base, { env: { CROFT_CAIRN_BIN: cairn.bin } })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('T-41\tcairn\tCAIRN-331\tdone\trefused: refused for a reason')
    expect(result.stdout).toMatch(/T-42\tcairn\tCAIRN-331\tdone\t.*closed/)
  })
})

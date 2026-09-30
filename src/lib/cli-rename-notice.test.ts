import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * A project key rename, as an agent actually meets it (CROFT-264).
 *
 * AC was renamed HOL on 2026-09-22. Old refs and `--project AC` went on
 * resolving, and nothing said so: `croft show AC-113` printed HOL-113 with no
 * explanation, `croft next --project AC` said "nothing open" about a project
 * with open work, and the only way to change a key was a hand-written PATCH.
 *
 * Spawned against a fake server, because what matters is what lands on stdout
 * (parsed) and stderr (read), not what the source looks like.
 */
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const RENAME = { key: 'AC', to: 'HOL', at: '2026-09-22T07:58:11.000Z', by: 'claude-code · cal@example.test' }

type Seen = { method?: string; path?: string; body?: Record<string, unknown> }
type Handler = (path: string, method: string) => { status?: number; body: unknown }

const serve = (handler: Handler, seen: Seen[] = []) =>
  new Promise<string>((resolve) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const entry: Seen = { method: req.method, path: req.url }
        if (raw) try { entry.body = JSON.parse(raw) } catch { /* not json */ }
        seen.push(entry)
        const { status = 200, body } = handler(req.url ?? '', req.method ?? 'GET')
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const run = async (args: string[], base: string, map?: Record<string, string>) => {
  const home = await mkdtemp(join(tmpdir(), 'croft-rename-'))
  directories.push(home)
  if (map) {
    await mkdir(join(home, '.croft'), { recursive: true })
    await writeFile(join(home, '.croft', 'projects.json'), JSON.stringify(map))
  }
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', ['cli/croft.mjs', ...args], {
      env: { ...process.env, HOME: home, CROFT_BASE_URL: base, CROFT_API_KEY: 'test-key', CROFT_AGENT: 'test' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const ok = (data: unknown) => ({ body: { success: true, data } })

describe('croft show through a retired key', () => {
  it('says the ref changed, on stderr, before the task', async () => {
    const base = await serve(() =>
      ok({ ref: 'HOL-113', number: 113, title: 'Wire the relay', status: 'doing',
           requested_ref: 'AC-113', renamed_from: RENAME, former_refs: ['AC-113'] }),
    )
    const { stdout, stderr, code } = await run(['show', 'AC-113'], base)

    expect(code).toBe(0)
    expect(stderr).toContain(
      'AC-113 is now HOL-113 — project AC was renamed HOL on 2026-09-22 by claude-code · cal@example.test.',
    )
    expect(stderr).toContain('AC-113 still resolves; write HOL-113.')
    // stdout is parsed: the facts are fields there, never a sentence.
    expect(stdout).toContain('ref\tHOL-113')
    expect(stdout).toContain('renamed_from.to\tHOL')
    expect(stdout).not.toContain('is now')
  })

  it('says nothing when the ref is current', async () => {
    const base = await serve(() => ok({ ref: 'HOL-113', number: 113, title: 'Wire the relay' }))
    const { stderr } = await run(['show', 'HOL-113'], base)
    expect(stderr).not.toContain('renamed')
  })

  it('passes on the refusal for a ref that was never issued', async () => {
    const message =
      'No task AC-114. Project AC was renamed HOL on 2026-09-22, and HOL-114 was created after that, ' +
      'so AC-114 was never issued. Did you mean HOL-114?'
    const base = await serve(() => ({
      status: 404,
      body: { success: false, code: 'not_found', error: message, requested_ref: 'AC-114', renamed_from: RENAME },
    }))
    const { stderr, code } = await run(['show', 'AC-114'], base)
    expect(code).toBe(1)
    expect(stderr).toContain('Did you mean HOL-114?')
  })
})

describe('croft check on an old exact ref', () => {
  it('says which task the old ref reached', async () => {
    const base = await serve(() =>
      ok({ count: 1, results: [{ kind: 'task', ref: 'HOL-113', title: 'Wire the relay', status: 'doing',
                                 tokens: 40, requestedRef: 'AC-113', renamedFrom: RENAME }] }),
    )
    const { stdout, stderr } = await run(['check', 'AC-113'], base)
    expect(stderr).toContain('AC-113 is now HOL-113 — project AC was renamed HOL on 2026-09-22')
    expect(stdout).toContain('HOL-113')
  })
})

describe('--project with a retired key', () => {
  it('next answers for the live project and says so, instead of "nothing open"', async () => {
    const base = await serve(() =>
      ok({ pick: { ref: 'HOL-120', title: 'Ship the relay', reason: 'yours', priority: 'high', status: 'todo' },
           then: [], considered: 4, offerable: 1, renamed_from: RENAME }),
    )
    const { stdout, stderr } = await run(['next', '--project', 'AC'], base)
    expect(stdout).toContain('HOL-120')
    expect(stdout).not.toContain('nothing open')
    expect(stderr).toContain('note: project AC is now HOL — renamed on 2026-09-22')
  })

  it('list says so once, however many rows come back', async () => {
    const base = await serve(() =>
      ok({ count: 2, offset: 0, limit: 50, renamed_from: RENAME,
           tasks: [{ number: 1, title: 'a', status: 'todo', project: { key: 'HOL' } },
                   { number: 2, title: 'b', status: 'todo', project: { key: 'HOL' } }] }),
    )
    const { stdout, stderr } = await run(['list', '--project', 'AC'], base)
    expect(stdout).toContain('HOL-1')
    expect(stderr.match(/project AC is now HOL/g)).toHaveLength(1)
  })
})

describe('croft project list lists former keys', () => {
  it('as a trailing `was` column, keeping every column readers already key on', async () => {
    const base = await serve(() =>
      ok([
        { id: 'id-hol', key: 'HOL', title: 'Holloway', description: null, status: 'active', task_counter: 120,
          created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-22T00:00:00Z',
          former_keys: [{ key: 'AC', retired_at: RENAME.at, retired_by: RENAME.by, new_key: 'HOL' }] },
        { id: 'id-croft', key: 'CROFT', title: 'Croft', description: 'd', status: 'active', task_counter: 264,
          created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-22T00:00:00Z', former_keys: [] },
      ]),
    )
    const { stdout } = await run(['project', 'list'], base)
    // Not trimmed: an empty `was` is a trailing tab, and the cell count is the point.
    const [count, header, hol, croft] = stdout.split('\n')
    expect(count).toBe('#2')
    expect(header).toBe('id\tkey\ttitle\tstatus\ttask_counter\tcreated_at\tupdated_at\tdescription\twas')
    const cols = header!.split('\t')
    expect(hol!.split('\t')[cols.indexOf('key')]).toBe('HOL')
    expect(hol!.split('\t')[cols.indexOf('was')]).toBe('AC')
    expect(croft!.split('\t')).toHaveLength(cols.length)
    expect(stdout).not.toContain('former_keys')
  })
})

describe('changing a key from the CLI', () => {
  const rekeyed = () =>
    ok({ id: 'id-hol', key: 'HOL', title: 'Holloway', status: 'active', former_key: 'AC' })

  it('project rekey sends the new key and says old refs keep resolving', async () => {
    const seen: Seen[] = []
    const base = await serve(rekeyed, seen)
    const { stderr, stdout, code } = await run(['project', 'rekey', 'AC', 'HOL'], base)
    expect(code).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'PATCH', path: '/api/v1/projects/AC', body: { key: 'HOL' } })
    expect(stdout).toContain('former_key\tAC')
    expect(stderr).toContain('renamed AC -> HOL: every AC-n ref now reads HOL-n.')
    expect(stderr).toContain('AC-n refs keep resolving')
  })

  it('project rename --key is the same verb in the entities spelling', async () => {
    const seen: Seen[] = []
    const base = await serve(rekeyed, seen)
    const { code, stderr } = await run(['project', 'rename', 'AC', '--key', 'HOL', 'Holloway'], base)
    expect(code).toBe(0)
    expect(seen[0]?.body).toEqual({ key: 'HOL', title: 'Holloway' })
    expect(stderr).not.toContain('unknown flag')
  })

  it('refuses a key that is not one before asking the server', async () => {
    const seen: Seen[] = []
    const base = await serve(rekeyed, seen)
    const { code, stderr } = await run(['project', 'rekey', 'AC', 'hol'], base)
    expect(code).toBe(1)
    expect(stderr).toContain('is not a project key')
    expect(seen).toHaveLength(0)
  })
})

describe('the briefing after a rename', () => {
  it('names the held task by its new ref and the one it had', async () => {
    const base = await serve(() =>
      ok({ project: 'HOL', projectRenamed: RENAME,
           held: [{ ref: 'HOL-113', was: ['AC-113'], title: 'Wire the relay', status: 'doing', quiet: false }],
           inFlight: [], knowledge: [], staleClaims: [], lastSession: null }),
    )
    const { stdout } = await run(['context', '--project', 'AC'], base)
    expect(stdout).toContain('## Croft [HOL]')
    expect(stdout).toContain('AC was renamed HOL on 2026-09-22')
    expect(stdout).toContain('HOL-113 (was AC-113)  doing')
  })
})

describe('croft map and a retired key', () => {
  it('warns about a checkout still mapped to it', async () => {
    const base = await serve(() =>
      ok([{ id: 'id-hol', key: 'HOL', former_keys: [{ key: 'AC', retired_at: RENAME.at }] }]),
    )
    const { stdout, stderr } = await run(['map'], base, { '/work/holloway': 'AC', '/work/croft': 'CROFT' })
    expect(stdout).toContain('AC\t/work/holloway')
    expect(stderr).toContain('/work/holloway is mapped to AC, which was renamed HOL on 2026-09-22')
    expect(stderr).not.toContain('/work/croft')
  })

  it('stays quiet, and still lists, when the server cannot say', async () => {
    const base = await serve(() => ({ status: 500, body: { success: false, error: 'down' } }))
    const { stdout, code } = await run(['map'], base, { '/work/holloway': 'AC' })
    expect(code).toBe(0)
    expect(stdout).toContain('AC\t/work/holloway')
  })
})

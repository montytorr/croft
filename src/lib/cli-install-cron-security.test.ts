import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * scripts/install-cron.mjs, two findings from a security review of the setup
 * flow it is part of:
 *
 * F2 — a value rendered into a crontab line (a path with a space, an agent
 * name derived from the filesystem, an operator-set env override) used to go
 * in unquoted and un-escaped. `cronLine` now single-quotes every value for
 * the shell, and separately escapes a literal `%` for cron's own newline
 * handling (crontab(5), which runs before the shell ever sees the line) —
 * this pins the round trip end to end, through `--install` into a real
 * (faked) crontab and back out through `--run`.
 *
 * F3 — `--install --only X` used to rewrite the whole managed block, which
 * silently dropped every previously-installed job not named in `X`. `croft
 * setup` calls this with `--only` on every run, so a second run used to
 * quietly un-schedule reconcile the moment a caller asked for just
 * agent-files. This pins that a scoped re-run keeps the rest.
 *
 * All of this is exercised against a fake `crontab` executable on PATH that
 * reads from and writes to a plain file, so nothing here ever touches a real
 * crontab (the same technique install-cron-run.test.ts uses for --run).
 */

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const run = (args: string[], environment: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('node', ['scripts/install-cron.mjs', ...args], { env: environment })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

const RECORDER = `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.RECORD, JSON.stringify({ args: process.argv.slice(2) }))
`

/** A machine with a fake crontab (a plain file) and everything reconcile and
 * agent-files each need to be "applicable". */
const setUp = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'croft-install-cron-security-'))
  temporaryDirectories.push(directory)

  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  const crontabFile = join(directory, 'crontab.txt')
  await writeFile(crontabFile, '17 3 * * * /usr/bin/someone-elses-backup\n')

  const fakeCrontab = join(bin, 'crontab')
  await writeFile(fakeCrontab, `#!/bin/sh
if [ "$1" = "-l" ]; then cat "$FAKE_CRONTAB"; else cat > "$FAKE_CRONTAB"; fi
`)
  await chmod(fakeCrontab, 0o755)

  // reconcile requires only the CLI to exist; agent-files requires its sync
  // script and node.
  const cli = join(directory, 'croft')
  await writeFile(cli, "#!/usr/bin/env node\nconsole.log('all-instances', 'server-only')\n")

  const recorder = join(directory, 'recorder.mjs')
  await writeFile(recorder, RECORDER)

  const recorded = join(directory, 'recorded.json')

  return {
    directory,
    crontabFile,
    recorded,
    recorder,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_CRONTAB: crontabFile,
      RECORD: recorded,
      CROFT_CLI_PATH: cli,
      CROFT_NODE_PATH: process.execPath,
      CROFT_SYNC_SCRIPT: recorder,
      CROFT_LOG_DIR: directory,
    },
  }
}

describe('install-cron.mjs — crontab quoting (F2)', () => {
  it('round-trips a path containing a space through --install and --run', async () => {
    const { crontabFile, recorded, recorder, environment } = await setUp()
    const spacedSync = recorder.replace('recorder.mjs', 'a recorder with spaces.mjs')
    await writeFile(spacedSync, RECORDER)
    const env = { ...environment, CROFT_SYNC_SCRIPT: spacedSync }

    const installed = await run(['--install', '--only', 'agent-files', '--cron'], env)
    expect(installed.code).toBe(0)

    const crontab = await readFile(crontabFile, 'utf8')
    // The path is quoted as one shell word, not left to be split on its space.
    expect(crontab).toContain(`'${spacedSync}'`)

    const ran = await run(['--run', 'agent-files', '--cron'], env)
    // A path wrongly split on its space would make node treat a fragment of
    // it as the script to run (MODULE_NOT_FOUND) rather than the whole path —
    // a non-zero exit and no recorded file are exactly what that looks like.
    expect(ran.code).toBe(0)
    expect(existsSync(recorded)).toBe(true)
  })

  it('escapes a literal % so cron cannot read it as a newline, and unescapes it back out', async () => {
    const { crontabFile, recorded, environment } = await setUp()
    const env = { ...environment, CROFT_NOTIFY_FILES: 'weekly: 100% done' }

    const installed = await run(['--install', '--only', 'agent-files', '--cron'], env)
    expect(installed.code).toBe(0)

    const crontab = await readFile(crontabFile, 'utf8')
    const line = crontab.split('\n').find((l) => l.includes('--notify'))
    expect(line).toBeDefined()
    // cron's own preprocessing (crontab(5)) treats a bare % as a newline
    // before the shell ever runs; only a backslash-escaped one survives as a
    // literal character all the way to the argument the recorder sees.
    expect(line).not.toMatch(/(?<!\\)%/)
    expect(line).toContain('\\%')

    const ran = await run(['--run', 'agent-files', '--cron'], env)
    expect(ran.code).toBe(0)
    const record = JSON.parse(await readFile(recorded, 'utf8'))
    expect(record.args).toContain('weekly: 100% done')
  })

  it('refuses a notify target carrying a line break, which would forge a crontab line', async () => {
    const { environment } = await setUp()
    const result = await run(['--cron'], { ...environment, CROFT_NOTIFY_FILES: 'CROFT-1\n* * * * * evil' })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('CROFT_NOTIFY_FILES contains a newline')
  })
})

describe('install-cron.mjs — --only keeps other jobs (F3)', () => {
  it('installs server sync as maintenance and preserves it across later scoped installs', async () => {
    const { crontabFile, environment, recorded } = await setUp()
    await writeFile(environment.CROFT_CLI_PATH, `#!/usr/bin/env node
// 'all-instances', 'server-only'
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.RECORD, JSON.stringify({ args: process.argv.slice(2), agent: process.env.CROFT_AGENT }))
`)
    await chmod(environment.CROFT_CLI_PATH, 0o755)
    expect((await run(['--install', '--only', 'reconcile,sync', '--cron'], environment)).code).toBe(0)
    const before = await readFile(crontabFile, 'utf8')
    expect(before).toContain("*/15 * * * * CROFT_AGENT='maintenance'")
    expect(before).toContain("'sync' '--server-only' '--all-instances'")
    expect((await run(['--install', '--only', 'agent-files', '--cron'], environment)).code).toBe(0)
    const after = await readFile(crontabFile, 'utf8')
    expect(after.match(/# sync:/g)).toHaveLength(1)
    expect(after).toContain('someone-elses-backup')
    expect((await run(['--run', 'sync', '--cron'], environment)).code).toBe(0)
    expect(JSON.parse(await readFile(recorded, 'utf8'))).toEqual({ args: ['sync', '--server-only', '--all-instances'], agent: 'maintenance' })
    expect((await run(['--remove', '--only', 'sync', '--cron'], environment)).code).toBe(0)
    const removed = await readFile(crontabFile, 'utf8')
    expect(removed).not.toContain('# sync:')
    expect(removed).toContain('# reconcile:')
  })

  it('does not schedule sync against a CLI that predates server-only', async () => {
    const { environment, crontabFile } = await setUp()
    await writeFile(environment.CROFT_CLI_PATH, "#!/usr/bin/env node\nconsole.log('all-instances')\n")
    const result = await run(['--install', '--only', 'sync', '--cron'], environment)
    expect(result.stderr).toContain('predates --server-only')
    expect(await readFile(crontabFile, 'utf8')).not.toContain('# sync:')
  })

  it('keeps reconcile when a later --only agent-files run re-renders just that job', async () => {
    const { crontabFile, environment } = await setUp()

    const first = await run(['--install', '--only', 'agent-files,reconcile', '--cron'], environment)
    expect(first.code).toBe(0)
    const afterFirst = await readFile(crontabFile, 'utf8')
    expect(afterFirst).toContain('# reconcile:')
    expect(afterFirst).toContain('# agent-files:')

    const second = await run(['--install', '--only', 'agent-files', '--cron'], environment)
    expect(second.code).toBe(0)

    const afterSecond = await readFile(crontabFile, 'utf8')
    // The job this run never named is untouched, not dropped.
    expect(afterSecond).toContain('# reconcile:')
    expect(afterSecond).toContain('# agent-files:')
    // Exactly one line per job: a merge, not an accidental duplicate.
    expect(afterSecond.match(/# reconcile:/g)).toHaveLength(1)
    expect(afterSecond.match(/# agent-files:/g)).toHaveLength(1)
  })

  it('drops a retired memory job (vitals, openclaw-sessions) left in the block by an older install', async () => {
    const { crontabFile, environment } = await setUp()
    await writeFile(
      crontabFile,
      [
        '17 3 * * * /usr/bin/someone-elses-backup',
        '# >>> croft maintenance (managed by scripts/install-cron.mjs)',
        '# vitals: Asks daily whether the memory is still being written.',
        "0 8 * * * '/x/croft' 'vitals'",
        '# <<< croft maintenance',
        '',
      ].join('\n'),
    )
    const result = await run(['--install', '--only', 'agent-files', '--cron'], environment)
    expect(result.code).toBe(0)
    const after = await readFile(crontabFile, 'utf8')
    expect(after).not.toContain('vitals')
    expect(after).toContain('# agent-files:')
    expect(after).toContain('someone-elses-backup')
  })

  it('removes just the named job with --remove --only, keeping the others', async () => {
    const { crontabFile, environment } = await setUp()
    await run(['--install', '--only', 'agent-files,reconcile', '--cron'], environment)

    const removed = await run(['--remove', '--only', 'reconcile', '--cron'], environment)
    expect(removed.code).toBe(0)

    const after = await readFile(crontabFile, 'utf8')
    expect(after).not.toContain('# reconcile:')
    expect(after).toContain('# agent-files:')
  })

  it('still fully removes the managed block on a plain --remove with no --only', async () => {
    const { crontabFile, environment } = await setUp()
    await run(['--install', '--only', 'agent-files,reconcile', '--cron'], environment)

    const removed = await run(['--remove', '--cron'], environment)
    expect(removed.code).toBe(0)

    const after = await readFile(crontabFile, 'utf8')
    expect(after).not.toContain('croft maintenance')
    expect(after).toContain('someone-elses-backup')
  })
})

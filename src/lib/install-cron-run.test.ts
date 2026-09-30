import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `install-cron.mjs --run <job>` is what closes the gap between a push-based
 * deploy and a pull-based hourly sync (CROFT-257): the deploy asks for the job
 * that is already scheduled rather than restating it. So what is worth pinning
 * is exactly that — that the command it runs is the one in the schedule, and
 * that the two documented overrides are the only differences it makes.
 *
 * End to end this can only be exercised by a real deploy, which is precisely
 * why the parsing is pinned here instead.
 *
 * Every path below is built under a temporary directory: the targets a real
 * host syncs to are other people's home directories, and this repository is
 * public.
 */

const temporaryDirectories: string[] = []

const run = (args: string[], environment: NodeJS.ProcessEnv) => new Promise<{
  code: number | null
  stdout: string
  stderr: string
}>((resolve, reject) => {
  const child = spawn('node', ['scripts/install-cron.mjs', ...args], { env: environment })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, stdout, stderr }))
})

/** The markers as the installer itself spells them, so this cannot drift from it. */
const markers = () => {
  const source = readFileSync('scripts/install-cron.mjs', 'utf8')
  const read = (name: string) => {
    const match = new RegExp(`^const ${name} = '(.*)'$`, 'm').exec(source)
    if (!match) throw new Error(`no ${name} marker in scripts/install-cron.mjs`)
    return match[1]
  }
  return { begin: read('BEGIN'), end: read('END') }
}

/** The shape of a real `--also` list: another account's tree, and a hook. */
const alsoTargets = (base: string) => [
  `skill=${base}/another-account/.claude/skills/croft/SKILL.md`,
  `skill=${base}/another-runtime/skills/croft/SKILL.md`,
  `hook:context=${base}/another-account/.croft/hooks/croft-context.mjs`,
]

const alsoFlags = (base: string) => alsoTargets(base).flatMap((target) => ['--also', target])

const RECORDER = `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.RECORD, JSON.stringify({
  args: process.argv.slice(2),
  agent: process.env.CROFT_AGENT ?? null,
}))
`

/**
 * A crontab holding somebody else's scheduling, our managed block, and inside
 * it an `agent-files` line shaped exactly as the installer renders one: five
 * schedule fields, an environment assignment, the command, and the redirect.
 */
const setUp = async (syncArgs: (base: string) => string[]) => {
  const directory = await mkdtemp(join(tmpdir(), 'croft-run-job-test-'))
  temporaryDirectories.push(directory)

  const bin = join(directory, 'bin')
  await mkdir(bin)

  const crontabFile = join(directory, 'crontab.txt')
  const recorded = join(directory, 'recorded.json')
  const recorder = join(directory, 'recorder.mjs')
  await writeFile(recorder, RECORDER)

  const fakeCrontab = join(bin, 'crontab')
  await writeFile(fakeCrontab, `#!/bin/sh
if [ "$1" = "-l" ]; then cat "$FAKE_CRONTAB"; else cat > /dev/null; fi
`)
  await chmod(fakeCrontab, 0o755)

  const { begin, end } = markers()
  await writeFile(crontabFile, [
    '17 3 * * * /usr/bin/someone-elses-backup',
    begin,
    '# reconcile: Releases claims an agent stopped working on, and moves the task back to todo.',
    '*/30 * * * * CROFT_AGENT=maintenance /usr/local/bin/croft reconcile >> /var/log/croft-reconcile.log 2>&1',
    '# agent-files: Repairs the skill, CLI and hooks wherever a runtime reads a stale copy.',
    `23 * * * * CROFT_AGENT=maintenance ${process.execPath} ${recorder} ` +
      `${syncArgs(directory).join(' ')} >> /var/log/croft-agent-files.log 2>&1`,
    end,
    '',
  ].join('\n'))

  return {
    directory,
    recorded,
    recorder,
    environment: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_CRONTAB: crontabFile,
      RECORD: recorded,
    },
  }
}

const scheduledArgs = (base: string) => [
  '--source', 'https://raw.example/main',
  ...alsoFlags(base),
  '--notify', 'CROFT-107',
]

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('install-cron --run', () => {
  it('runs the scheduled command verbatim, without its schedule or its log redirect', async () => {
    const { directory, recorded, environment } = await setUp(scheduledArgs)

    const result = await run(['--run', 'agent-files', '--cron'], environment)

    expect(result.code).toBe(0)
    const record = JSON.parse(await readFile(recorded, 'utf8'))
    expect(record.args).toEqual(scheduledArgs(directory))
    // The environment the schedule states, not whatever the caller happened to
    // have: a maintenance job writing under the wrong identity is its own bug.
    expect(record.agent).toBe('maintenance')
  })

  it('replaces --source in place and drops --notify, keeping every --also target', async () => {
    const { directory, recorded, environment } = await setUp(scheduledArgs)

    const result = await run(
      ['--run', 'agent-files', '--cron', '--source', directory, '--no-notify'],
      environment,
    )

    expect(result.code).toBe(0)
    const record = JSON.parse(await readFile(recorded, 'utf8'))
    expect(record.args).toEqual(['--source', directory, ...alsoFlags(directory)])
  })

  it('appends --source when the scheduled command has none', async () => {
    const { directory, recorded, environment } = await setUp(alsoFlags)

    const result = await run(['--run', 'agent-files', '--cron', '--source', directory], environment)

    expect(result.code).toBe(0)
    const record = JSON.parse(await readFile(recorded, 'utf8'))
    expect(record.args).toEqual([...alsoFlags(directory), '--source', directory])
  })

  it('refuses a job that is not installed rather than inventing one', async () => {
    const { recorded, environment } = await setUp(alsoFlags)

    const result = await run(['--run', 'openclaw-sessions', '--cron'], environment)

    expect(result.code).toBe(3)
    expect(result.stderr).toContain('No openclaw-sessions job is installed')
    expect(existsSync(recorded)).toBe(false)
  })

  it('reports the exit code of the job it ran', async () => {
    // A sync that could not write a single copy must not read as a clean deploy
    // step, so the child's status is the one that comes back out.
    const { recorded, recorder, environment } = await setUp(() => ['--source', 'https://raw.example/main'])
    await writeFile(recorder, `${RECORDER}process.exit(7)\n`)

    const result = await run(['--run', 'agent-files', '--cron'], environment)

    expect(result.code).toBe(7)
    expect(existsSync(recorded)).toBe(true)
  })

  it('reads back a LaunchAgent this installer rendered, so the two backends agree', async () => {
    // A round trip rather than a fixture: the plist is produced by the
    // installer and then parsed by --run, so a change to either half that the
    // other does not follow fails here. That is the whole claim this file makes
    // about a job having one definition.
    const directory = await mkdtemp(join(tmpdir(), 'croft-run-plist-test-'))
    temporaryDirectories.push(directory)
    const recorded = join(directory, 'recorded.json')
    const recorder = join(directory, 'recorder.mjs')
    await writeFile(recorder, RECORDER)

    const environment = {
      ...process.env,
      HOME: directory,
      RECORD: recorded,
      CROFT_NODE_PATH: process.execPath,
      CROFT_SYNC_SCRIPT: recorder,
      CROFT_LOG_DIR: directory,
      CROFT_RAW_BASE: 'https://raw.example/main',
      CROFT_NOTIFY_FILES: 'CROFT-107',
      CROFT_SYNC_ALSO: alsoTargets(directory).join(','),
    }

    const printed = await run(['--only', 'agent-files', '--launchd'], environment)
    const plist = printed.stdout.slice(printed.stdout.indexOf('<?xml'), printed.stdout.indexOf('</plist>') + 9)
    expect(plist).toContain('com.croft.agent-files')

    await mkdir(join(directory, 'Library/LaunchAgents'), { recursive: true })
    await writeFile(join(directory, 'Library/LaunchAgents/com.croft.agent-files.plist'), plist)

    const result = await run(
      ['--run', 'agent-files', '--launchd', '--source', directory, '--no-notify'],
      environment,
    )

    expect(result.code).toBe(0)
    const record = JSON.parse(await readFile(recorded, 'utf8'))
    expect(record.args).toEqual(['--source', directory, ...alsoFlags(directory)])
    expect(record.agent).toBe('maintenance')
  })

  it('will not install or remove while running a job', async () => {
    const { environment } = await setUp(alsoFlags)

    const result = await run(['--run', 'agent-files', '--cron', '--install'], environment)

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--run does one thing')
  })
})

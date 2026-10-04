import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * hooks/croft-context.mjs, the SessionStart briefing. It runs `croft context
 * --brief --cwd <cwd>` and passes on whatever that prints — and in every other
 * case says nothing and exits 0, promptly. A briefing hook that can stall or
 * fail a session start is worse than none.
 */
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const hook = async (
  croftScript: string,
  { env = {} as Record<string, string>, payload = { hook_event_name: 'SessionStart', cwd: '/work/lab' } as Record<string, unknown> } = {},
) => {
  const dir = await mkdtemp(join(tmpdir(), 'croft-context-hook-'))
  directories.push(dir)
  const cli = join(dir, 'croft')
  await writeFile(cli, `#!/bin/sh\n${croftScript}\n`)
  await chmod(cli, 0o755)
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.endsWith('_SUMMARISER')),
  )
  const started = Date.now()
  return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
    const child = spawn('node', ['hooks/croft-context.mjs'], {
      env: { ...clean, CROFT_CLI: cli, ...env } as unknown as NodeJS.ProcessEnv,
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }))
    child.stdin.end(JSON.stringify(payload))
  })
}

describe('the SessionStart briefing hook', () => {
  it('runs context --brief for the session directory and injects what it prints', async () => {
    const { code, stdout } = await hook('echo "Croft — lab: $*"')
    expect(code).toBe(0)
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(out.hookSpecificOutput.additionalContext).toBe('Croft — lab: context --brief --cwd /work/lab')
  })

  it('is silent when the CLI prints nothing', async () => {
    const { code, stdout } = await hook('exit 0')
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('is silent when the CLI fails, whatever it says on stderr', async () => {
    for (const script of ['echo "boom" >&2; exit 1', 'echo "Ask the user" >&2; exit 10']) {
      const { code, stdout } = await hook(script)
      expect(code).toBe(0)
      expect(stdout).toBe('')
    }
  })

  it('is silent when the CLI is missing', async () => {
    const { code, stdout } = await hook('exit 0', { env: { CROFT_CLI: '/nonexistent/croft' } })
    expect(code).toBe(0)
    expect(stdout).toBe('')
  })

  it('gives up at its deadline instead of holding the session', async () => {
    const { code, stdout, ms } = await hook('sleep 5; echo late', { env: { CROFT_HOOK_TIMEOUT_MS: '300' } })
    expect(code).toBe(0)
    expect(stdout).toBe('')
    expect(ms).toBeLessThan(3000)
  })

  it('stays out of every summariser run', async () => {
    for (const name of ['AGENT_MEMORY_SUMMARISER', 'CROFT_SUMMARISER']) {
      const { code, stdout } = await hook('echo "Croft — lab: 1 exploring"', { env: { [name]: '1' } })
      expect(code, name).toBe(0)
      expect(stdout, name).toBe('')
    }
  })

  it('reads no other product\'s summariser flag', async () => {
    for (const name of ['CAIRN_SUMMARISER', 'QUARRY_SUMMARISER']) {
      const { stdout } = await hook('echo "Croft — lab: 1 exploring"', { env: { [name]: '1' } })
      expect(stdout, name).toContain('Croft — lab: 1 exploring')
    }
  })

  it('ignores any event but SessionStart and a Hermes first turn', async () => {
    const { stdout } = await hook('echo brief', {
      payload: { hook_event_name: 'PreToolUse', cwd: '/w', tool_input: { file_path: '/w/a.ts' } },
    })
    expect(stdout).toBe('')
  })

  it('finds the CLI where `croft setup` puts it when PATH does not have it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'croft-context-home-'))
    directories.push(home)
    await mkdir(join(home, '.local/bin'), { recursive: true })
    const cli = join(home, '.local/bin/croft')
    await writeFile(cli, '#!/bin/sh\necho "Croft — lab: 2 exploring"\n')
    await chmod(cli, 0o755)
    const stdout = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['hooks/croft-context.mjs'], {
        env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv,
      })
      let out = ''
      child.stdout.on('data', (c: Buffer) => { out += c.toString() })
      child.on('close', () => resolve(out))
      child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/work/lab' }))
    })
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toBe('Croft — lab: 2 exploring')
  })
})

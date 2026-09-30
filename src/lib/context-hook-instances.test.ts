import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * CROFT-297. With several instances and no route for the directory, `croft
 * context` exits 10 and says on stderr what to ask the user. That is the one
 * failure the briefing hook must not swallow: an agent told nothing finds out
 * at its first write, after the moment to ask has passed.
 */
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const hook = async (croftScript: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'croft-context-hook-'))
  directories.push(dir)
  const cli = join(dir, 'croft')
  await writeFile(cli, `#!/bin/sh\n${croftScript}\n`)
  await chmod(cli, 0o755)
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn('node', ['hooks/croft-context.mjs'], {
      env: { ...process.env, CROFT_CLI: cli, TRIG_CLI: join(dir, 'no-trig') },
    })
    let stdout = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.on('close', (code) => resolve({ code, stdout }))
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', cwd: '/work/client-site' }))
  })
}

describe('the briefing hook on a machine with several instances', () => {
  it("passes on the CLI's instruction to ask when the directory has no instance", async () => {
    const { code, stdout } = await hook('echo "croft: nothing says which one ~/work/client-site is for. Ask the user" >&2; exit 10')
    expect(code).toBe(0)
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext
    expect(context).toContain('Ask the user')
  })

  it('stays silent on any other failure, as before', async () => {
    const { stdout } = await hook('echo "boom" >&2; exit 1')
    expect(stdout).toBe('')
  })
})

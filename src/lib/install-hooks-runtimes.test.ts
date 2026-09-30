import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * `croft setup` pairs keys for the runtimes it was given (or detected), then
 * wires hooks. The hook installer used to wire every runtime it found —
 * including Hermes, which setup never pairs a key for, through
 * `hermes config set --force`. `--runtimes` limits it to the paired ones.
 */

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const machine = async () => {
  const home = await mkdtemp(join(tmpdir(), 'croft-hooks-runtimes-'))
  temporaryDirectories.push(home)
  await mkdir(join(home, '.claude'), { recursive: true })
  await writeFile(join(home, '.claude', 'settings.json'), '{}\n')
  await mkdir(join(home, '.codex'), { recursive: true })
  const bin = join(home, 'bin')
  await mkdir(bin)
  // A fake hermes that records being called and answers an empty hooks map.
  const hermes = join(bin, 'hermes')
  await writeFile(hermes, `#!/bin/sh\necho "$@" >> "${join(home, 'hermes-calls')}"\necho '{}'\n`)
  await chmod(hermes, 0o755)
  return { home, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, OPENCLAW_CONFIG_PATH: join(home, 'none.json') } }
}

const install = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('node', ['scripts/install-hooks.mjs', ...args], { env })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr.on('data', (c: Buffer) => { out += c.toString() })
    child.on('error', reject)
    child.on('close', () => resolve(out))
  })

describe('install-hooks --runtimes', () => {
  it('wires only the runtimes it is given', async () => {
    const { home, env } = await machine()
    const out = await install(['--runtimes', 'claude-code'], env)
    expect(await readFile(join(home, '.claude', 'settings.json'), 'utf8')).toContain('croft-context.mjs')
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false)
    expect(existsSync(join(home, 'hermes-calls'))).toBe(false)
    expect(out).toContain('codex: not in --runtimes')
  })

  it('still wires every runtime found when run by hand', async () => {
    const { home, env } = await machine()
    await install([], env)
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true)
    expect(existsSync(join(home, 'hermes-calls'))).toBe(true)
  })
})

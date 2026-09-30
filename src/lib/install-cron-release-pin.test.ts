import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The agent-files job repairs every copy of the CLI, the skill and the hooks
 * to what its source serves, every 15 minutes on a Mac. With `main` as the
 * default source, any push to `main` ran on every connected machine within the
 * quarter hour. The default is now the tag of the release the installer ships
 * with; tracking `main` is an explicit CROFT_RAW_BASE.
 */

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const plan = (environment: NodeJS.ProcessEnv) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('node', ['scripts/install-cron.mjs', '--only', 'agent-files'], { env: environment })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr.on('data', (c: Buffer) => { out += c.toString() })
    child.on('error', reject)
    child.on('close', () => resolve(out))
  })

const VERSION = readFileSync('cli/croft.mjs', 'utf8').match(/^const VERSION = '([^']+)'/m)?.[1]

const machine = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'croft-release-pin-'))
  temporaryDirectories.push(directory)
  const sync = join(directory, 'sync-agent-files.mjs')
  await writeFile(sync, '')
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, CROFT_SYNC_SCRIPT: sync, CROFT_NODE_PATH: process.execPath, CROFT_LOG_DIR: directory }
  delete env.CROFT_RAW_BASE
  return env
}

describe('agent-files repair source', () => {
  it('defaults to the tag of the release the installer ships with, not main', async () => {
    expect(VERSION).toBeTruthy()
    const out = await plan(await machine())
    expect(out).toContain(`raw.githubusercontent.com/montytorr/croft/v${VERSION}`)
    expect(out).not.toContain('raw.githubusercontent.com/montytorr/croft/main')
  })

  it('still tracks main when a host asks for it', async () => {
    const out = await plan({ ...(await machine()), CROFT_RAW_BASE: 'https://raw.githubusercontent.com/montytorr/croft/main' })
    expect(out).toContain('raw.githubusercontent.com/montytorr/croft/main')
  })
})

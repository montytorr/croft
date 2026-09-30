import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

const run = (command: string, args: string[], environment: NodeJS.ProcessEnv) => new Promise<{
  code: number | null
  stderr: string
}>((resolve, reject) => {
  const child = spawn(command, args, { env: environment })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, stderr }))
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('backup script', () => {
  it('uses CROFT_DB_USER for the pg_dump container command', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'croft-backup-test-'))
    temporaryDirectories.push(directory)
    const bin = join(directory, 'bin')
    const backup = join(directory, 'backup')
    const attachments = join(directory, 'attachments')
    const dockerLog = join(directory, 'docker.log')
    const fakeDocker = join(bin, 'docker')

    await mkdir(bin)
    await mkdir(attachments)
    await writeFile(fakeDocker, `#!/bin/sh
printf '%s\\n' "$*" > "$DOCKER_LOG"
head -c 2048 /dev/zero
`)
    await chmod(fakeDocker, 0o755)

    const result = await run('bash', ['scripts/backup.sh'], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CROFT_BACKUP_DIR: backup,
      CROFT_DB_CONTAINER: 'test-postgres',
      CROFT_DB_NAME: 'test-croft',
      CROFT_DB_USER: 'croft_app',
      CROFT_ATTACHMENT_DIR: attachments,
      DOCKER_LOG: dockerLog,
    })

    expect(result.code, result.stderr).toBe(0)
    expect(await readFile(dockerLog, 'utf8')).toBe('exec test-postgres pg_dump -U croft_app -d test-croft -Fc --schema=public --no-owner --no-privileges\n')
  })
})

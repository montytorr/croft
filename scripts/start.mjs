#!/usr/bin/env node
/**
 * The container's entry point: optional start-up chores, then the server.
 *
 * With neither variable set this is exactly `node server.js`, which is what
 * the compose deployment runs (it migrates in a separate `migrate` service).
 * A platform with no one-off tasks — App Runner — cannot run that service, so:
 *
 * - CROFT_MIGRATE_ON_START=1 applies migrations before serving. Safe with
 *   several containers starting at once: migrate() holds an advisory lock.
 * - CROFT_BOOTSTRAP_ADMIN_EMAIL / _PASSWORD (/ _NAME) create the first
 *   administrator when there is none, and do nothing once there is one. Remove
 *   them after the first start; they are not a way to reset a password.
 *
 * A failure here stops the container rather than serving an unmigrated
 * schema: a platform that health-checks the new version keeps the old one.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const url = process.env.DATABASE_URL

// Each chore is imported only when it is asked for, so a start with neither
// set loads nothing but the server — exactly what the image ran before.
if (process.env.CROFT_MIGRATE_ON_START === '1') {
  const { migrate } = await import('./migrate.mjs')
  await migrate(url, { dir: join(root, 'migrations'), log: (line) => console.log(`[migrate] ${line}`) })
}

const bootstrapEmail = process.env.CROFT_BOOTSTRAP_ADMIN_EMAIL?.trim()
if (bootstrapEmail) {
  const { ensureOperator } = await import('./create-operator.mjs')
  const outcome = await ensureOperator({
    url,
    email: bootstrapEmail,
    password: process.env.CROFT_BOOTSTRAP_ADMIN_PASSWORD,
    displayName: process.env.CROFT_BOOTSTRAP_ADMIN_NAME?.trim() || null,
    onlyIfNoAdmin: true,
  })
  console.log(outcome === 'exists'
    ? '[bootstrap] an administrator already exists; nothing to do (remove CROFT_BOOTSTRAP_ADMIN_*)'
    : `[bootstrap] administrator ${bootstrapEmail} created`)
}

await import(join(root, 'server.js'))

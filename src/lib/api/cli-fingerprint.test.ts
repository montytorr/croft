import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { CLI_FINGERPRINT, CLI_HEADER, fingerprintOf } from './cli-fingerprint'
import { ok, fail, VERSION_HEADER } from './response'

/**
 * CROFT-246 put the release version on every response; CROFT-261 found that
 * it almost never fires, because 133 commits fitted inside v0.5.1 and a
 * hand-cut release is a coarse clock. These assertions are about the finer
 * one: a content hash, which is the only thing a CLI copied into
 * ~/.local/bin can work out about itself.
 */
describe('the CLI fingerprint a deployment advertises', () => {
  const sourceDigest = createHash('sha256')
    .update(readFileSync('cli/croft.mjs'))
    .digest('hex')
    .slice(0, 16)

  it('is the hash of the CLI in this tree when the image did not record one', () => {
    // In the container it comes from public/cli-hash.txt, written by the
    // Dockerfile because the standalone build does not trace `cli/`. Here
    // there is no such file, so it falls back to the source — which is what
    // makes `npm run dev` and this suite report a real fingerprint instead of
    // a special case.
    expect(CLI_FINGERPRINT).toBe(sourceDigest)
  })

  it('is the same digest the installer prints', () => {
    // scripts/sync-agent-files.mjs logs `cli  05b4c2f475bff8ff  cli/croft.mjs`.
    // If the two disagreed, the installer's line and the server's header would
    // describe the same file with two different strings and neither could be
    // checked against the other.
    expect(readFileSync('scripts/sync-agent-files.mjs', 'utf8')).toContain(
      "createHash('sha256').update(buffer).digest('hex').slice(0, 16)",
    )
    expect(fingerprintOf(readFileSync('cli/croft.mjs'))).toBe(sourceDigest)
  })

  it('rides on every success and every failure', () => {
    for (const response of [ok({ any: 'thing' }), fail('not_found', 'nope')]) {
      expect(response.headers.get(CLI_HEADER)).toBe(sourceDigest)
      expect(response.headers.get(VERSION_HEADER)).toBeTruthy()
    }
  })

  it('does not disturb a caller-supplied header or status', () => {
    const response = ok({ created: true }, { status: 201, headers: { 'x-test': 'kept' } })
    expect(response.status).toBe(201)
    expect(response.headers.get('x-test')).toBe('kept')
    expect(response.headers.get(CLI_HEADER)).toBe(sourceDigest)
  })
})

/**
 * /api/v1/health is the endpoint `croft --version` calls, and it was the one
 * route that built its response by hand — so the single command whose whole
 * job is to answer "am I current?" was the one that could not.
 */
describe('the health probe', () => {
  it('carries the fingerprint too', async () => {
    const { GET } = await import('@/app/api/v1/health/route')
    const response = GET()
    expect(response.headers.get(CLI_HEADER)).toBe(CLI_FINGERPRINT)
    const body = await response.json()
    // The shape callers already parse must not have moved.
    expect(body.success).toBe(true)
    expect(body.data.service).toBe('croft')
    expect(body.data.version).toBeTruthy()
    expect(body.data).toHaveProperty('build')
  })
})

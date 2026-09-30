import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `croft --version` compares the CLI against the server and is the only way a
 * stale copy announces itself. The server takes its number from package.json
 * (`src/app/api/v1/health/route.ts` imports it); the CLI restates it, because
 * cli/croft.mjs is a single standalone file copied to ~/.local/bin and cannot
 * import a package.json that will not be there.
 *
 * Two numbers, no link between them. Forget the CLI half of a release and it
 * reports the old version — which fails in the direction that reassures: every
 * stale install on every machine then agrees with a server that has moved on,
 * and the one mechanism we have for detecting staleness says all is well.
 *
 * So the link is this test.
 */
const cliVersion = (): string => {
  const source = readFileSync(join(process.cwd(), 'cli/croft.mjs'), 'utf8')
  const match = /^const VERSION = '([^']+)'/m.exec(source)
  if (!match) throw new Error('VERSION not found in cli/croft.mjs')
  return match[1]!
}

const packageVersion = (): string =>
  JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version

describe('release versions', () => {
  it('the CLI reports the version the server was built from', () => {
    expect(
      cliVersion(),
      'cli/croft.mjs VERSION and package.json disagree — bump both, or --version lies in the reassuring direction',
    ).toBe(packageVersion())
  })
})

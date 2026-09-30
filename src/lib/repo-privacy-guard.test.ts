import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * This repository is public, and twice now it has been written through with one
 * machine's layout and one workspace's private names.
 *
 * The first clean-up was a `git grep` run once by hand. It held for two days.
 * Two host paths and a client's slug went in afterwards, and a migration that
 * seeded another workspace's businesses into every fresh install survived both
 * passes — so this is the same check, run by CI instead of remembered.
 *
 * It deliberately does NOT carry a list of our own private names. A denylist of
 * things that must not appear in a public repository is itself a list of those
 * things in a public repository. What it checks instead is shape: an absolute
 * path into somebody's home directory is never right in a file anyone else will
 * clone, whoever's home it is. `CROFT_PRIVATE_TERMS` lets CI add real names
 * without committing them.
 */

const ROOT = join(__dirname, '..', '..')

/** Tracked files only: a checkout's untracked mess is nobody else's problem. */
const tracked = (): string[] =>
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)

/**
 * Binaries, the lockfile, and this test.
 *
 * The lockfile is generated and full of registry paths; this file has to name
 * the shapes it forbids in order to forbid them.
 */
const SKIP = /(^|\/)(package-lock\.json|repo-privacy-guard\.test\.ts)$|\.(png|jpe?g|gif|ico|woff2?|pdf)$/

/**
 * An absolute path into a named account's home.
 *
 * `/home/<user>/`, `/Users/<user>/` and `/root/<anything>` are all somebody's
 * machine. The env-var spellings (`$HOME`, `~`, `homedir()`) are how the same
 * path gets written when it is meant to be anyone's.
 */
const HOME_PATHS = [
  /\/home\/[a-z_][a-z0-9_-]*\//i,
  /\/Users\/[a-z_][a-z0-9_-]*\//i,
  /\/root\/[a-z_][a-z0-9_.-]+/i,
]

const extraTerms = (): RegExp[] =>
  (process.env.CROFT_PRIVATE_TERMS ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))

const offences = (patterns: RegExp[]): string[] => {
  const found: string[] = []
  for (const file of tracked()) {
    if (SKIP.test(file)) continue
    const path = join(ROOT, file)
    try {
      if (statSync(path).size > 2_000_000) continue
    } catch {
      continue // a submodule or a deleted-but-tracked path
    }
    const lines = readFileSync(path, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const pattern of patterns) {
        if (pattern.test(line)) found.push(`${file}:${i + 1}  ${line.trim().slice(0, 120)}`)
      }
    })
  }
  return found
}

describe('the repository does not carry one machine or one workspace', () => {
  it('has no absolute path into somebody\'s home directory', () => {
    const found = offences(HOME_PATHS)

    expect(
      found,
      'An absolute home path is one machine\'s layout, and this repository is public.\n' +
        'Take it from the environment, or use ~ / $HOME / homedir() so it is anyone\'s:\n\n' +
        found.join('\n'),
    ).toEqual([])
  })

  /**
   * The names that cannot be written down here. CI supplies them; locally this
   * passes vacuously, which is honest — a guard that needs a secret list is
   * only as good as the environment that has it.
   */
  it('has none of the private terms this environment was given', () => {
    const patterns = extraTerms()
    if (patterns.length === 0) return

    const found = offences(patterns)

    expect(
      found,
      'CROFT_PRIVATE_TERMS matched. These are names that must not ship:\n\n' + found.join('\n'),
    ).toEqual([])
  })
})

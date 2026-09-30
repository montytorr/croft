import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Which pages keep themselves current, and which deliberately do not.
 *
 * Three times in one afternoon a page disagreed with the server and the answer
 * was "it was open before the change" — which is a reasonable explanation once
 * and an excuse by the third time. Live updates existed but covered five of
 * thirteen pages, and the stream's fingerprint watched only tasks, so the pages
 * that go stale fastest were exactly the ones it could never have helped.
 *
 * The exclusions matter as much as the inclusions, so they are stated rather
 * than left to whoever notices next.
 */
const PAGES = join(process.cwd(), 'src/app/(app)')

/** Why a page is allowed to sit still. */
const DELIBERATELY_STATIC: Record<string, string> = {
  'search/page.tsx':
    'results are a snapshot of a query; re-running it under the reader would move rows they were looking at',
  'settings/page.tsx':
    'everything here changes only because you changed it, and the page already refreshes after its own writes',
  'settings/keys/page.tsx':
    'your own keys change when you pair or revoke one, and the page refreshes after its own revocations; ' +
    '"last used" is a timestamp worth reloading for, not one worth a live stream',
  'users/page.tsx':
    'administrator actions refresh the page after every write; remote account changes are deliberately not applied mid-form',
  'api-docs/page.tsx': 'the spec changes on deploy, not while you read',
  'connect/page.tsx': 'a bare code-entry form; there is nothing on it that can go stale',
  'connect/[code]/page.tsx':
    'one pairing, decided once, by whoever has the tab open; the client component already refreshes ' +
    'itself into a terminal state after its own Approve/Deny, and there is no one else\'s change to catch up to',
}

const pages = (dir: string, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return pages(join(dir, entry.name), rel)
    return entry.name === 'page.tsx' ? [rel] : []
  })

describe('pages stay current', () => {
  const all = pages(PAGES)

  it('finds the pages', () => {
    expect(all.length).toBeGreaterThan(8)
  })

  it('either subscribes to live updates or says why not', () => {
    const silent = all.filter(
      (rel) =>
        !readFileSync(join(PAGES, rel), 'utf8').includes('LiveUpdates') &&
        !DELIBERATELY_STATIC[rel],
    )
    expect(
      silent,
      `these neither refresh themselves nor explain why: ${silent.join(', ')}`,
    ).toEqual([])
  })

  it('watches every store, not just tasks', () => {
    // The stream compared max(tasks.updated_at) and count(tasks). Subscribing
    // the sessions or knowledge page to that would have been a subscription
    // that could never fire.
    const route = readFileSync(
      join(process.cwd(), 'src/app/api/v1/events/route.ts'),
      'utf8',
    )
    expect(route).toContain('croft_pulse')

    const migration = readFileSync(
      join(process.cwd(), 'migrations/037_pulse.sql'),
      'utf8',
    )
    for (const store of ['tasks', 'sessions', 'knowledge', 'task_activity_events']) {
      expect(migration, `the pulse ignores ${store}`).toContain(store)
    }
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A project key change must stay additive.
 *
 * A ref is designed to escape — into commit messages, PR titles, other agents'
 * notes — and those are immutable, so a rename that drops the old key silently
 * invalidates every reference already issued. The former key is therefore kept
 * and keeps resolving.
 *
 * Three pieces make that true, in three different files, and any one of them
 * reverting on its own would restore the silence without failing anything:
 * the rename has to be atomic with recording the old key, lookups have to fall
 * back to retired keys, and the renderer has to keep linkifying them.
 */
const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('renaming a project key keeps old refs working', () => {
  it('renames through the function that records the former key', () => {
    const route = read('src/app/api/v1/projects/[id]/route.ts')
    expect(route).toContain('project_rename_key')
    // The original bug in one line: `key` inside a general field update, which
    // changes the key and records nothing.
    expect(route).not.toMatch(/\.update\(body\)/)
  })

  it('resolves a ref through a retired key when the live key misses', () => {
    expect(read('src/lib/api/tasks.ts')).toContain('lookupFormerKey')
  })

  it('still linkifies refs written under a retired key', () => {
    // Bare refs are matched against this list at render time. A former key
    // missing from it is the case where an old ref still looks like a ref, is
    // still a link, and leads nowhere — the store breaking its own
    // cross-references.
    expect(read('src/app/(app)/layout.tsx')).toContain('listFormerKeys')
  })

  it('shows the former ref, not only resolves it', () => {
    // Resolution alone is half an answer: the lookup succeeds but the screen
    // shows the new ref, so a reader holding the old one cannot tell they
    // found the right task.
    // formerRefsOf is the version that only claims keys retired after the
    // task was filed (CROFT-264).
    const page = read('src/app/(app)/projects/[key]/tasks/[number]/page.tsx')
    expect(page).toContain('formerRefsOf')
    // Beside the imported ref, not instead of it: a renamed project imported
    // from Linear never showed the label at all.
    expect(page).not.toMatch(/!task\.external_ref/)
  })

  it('says so when an old address redirects', () => {
    // A silent swap of AC-113 for HOL-113 is the thing CROFT-264 fixed; the
    // redirect carries a marker and the todo page renders the notice from it.
    // (The project board that did the same went with the Projects menu.)
    const task = read('src/app/(app)/projects/[key]/tasks/[number]/page.tsx')
    expect(task).toMatch(/\?from=/)
    expect(task).toContain('RedirectNotice')
  })

  it('refuses to reuse a key another project retired', () => {
    // Reuse would leave every ACME-n ref resolving to two different tasks,
    // which is worse than refusing the rename.
    const migration = read('migrations/031_project_former_keys.sql')
    expect(migration).toContain('retired by another project')
    // One former key, one project, per owner — the constraint the refusal rests on.
    expect(migration).toMatch(/primary key \(owner_user_id, key\)/)
  })

  it('keeps live and retired keys in one workspace namespace', () => {
    const migration = read('migrations/047_shared_workspace_boundaries.sql')
    expect(migration).toContain('guard_project_key_namespace')
    expect(migration).toContain('projects_key_namespace_guard')
    expect(migration).toContain('former_keys_namespace_guard')
  })

  it('records who renamed it, through the rename function', () => {
    // The actor lived only in the activity event; 057 puts it on the former
    // key itself, and only if the route passes it.
    expect(read('src/app/api/v1/projects/[id]/route.ts')).toMatch(/p_actor:\s*actor\.actorId/)
  })
})

/**
 * Resolving an old ref silently was half of CROFT-264. AC became HOL and every
 * surface kept working while none of them said so: `show AC-113` returned
 * HOL-113 with no explanation, and `next --project AC` answered "nothing open"
 * about a project with open work, because it matched the key as a string.
 */
describe('a rename is told, not only resolved', () => {
  it('a task reached through a retired key says how it was reached', () => {
    const route = read('src/app/api/v1/tasks/[ref]/route.ts')
    expect(route).toContain('resolveTask')
    expect(route).toContain('renameFields')
    expect(read('src/lib/api/tasks.ts')).toMatch(/requested_ref:.*renamed_from:/)
  })

  it('the exact-ref search path carries the rename onto its row', () => {
    const search = read('src/lib/api/search.ts')
    expect(search).toContain('renamed_from: former.rename')
    expect(search).toContain('issuedUnderFormerKey')
  })

  // Every route that turns a project KEY into a project. A new one that matches
  // the key as a string brings back "No project AC" — or worse, an empty answer.
  it.each([
    'src/app/api/v1/projects/[id]/route.ts',
    'src/app/api/v1/projects/[id]/tasks/route.ts',
    'src/app/api/v1/projects/[id]/repos/route.ts',
    'src/app/api/v1/next/route.ts',
  ])('%s resolves through resolveProject', (path) => {
    const source = read(path)
    expect(source).toContain('resolveProject')
    expect(source).not.toMatch(/\.eq\('key', idOrKey/)
    expect(source).not.toMatch(/eq\('projects\.key', query\.project/)
  })

  it.each([
    'src/app/api/v1/search/route.ts',
    'src/app/api/v1/activity/route.ts',
    'src/app/api/v1/events/route.ts',
    'src/lib/api/context.ts',
  ])('%s normalises a --project filter to the live key', (path) => {
    expect(read(path)).toContain('liveProjectKey')
  })

  it('never claims a former ref for a task created after the rename', () => {
    const keys = read('src/lib/api/project-keys.ts')
    expect(keys).toMatch(/export const formerRefsOf/)
    expect(keys).toMatch(/Date\.parse\(former\.retired_at\) > created/)
  })

  it('titles rename rows in the feed by transforming the installed function', () => {
    // Re-copying activity_feed from an older file would revert everything
    // since — the failure 050 made with croft_vitals.
    const migration = read('migrations/057_project_renames_are_told.sql')
    expect(migration).toContain("pg_get_functiondef(fn)")
    expect(migration).not.toMatch(/create or replace function (public\.)?activity_feed/i)
    expect(migration).not.toMatch(/create or replace function (public\.)?project_rename_key/i)
    expect(migration).toContain("''project_key_changed'', ''project_renamed''")
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formerRefsOf,
  issuedUnderFormerKey,
  liveProjectKey,
  lookupFormerKey,
  projectsForKeys,
  resolveProject,
} from './project-keys'
import { recentFormerRefs } from './context'
import { noSuchTaskMessage, renameFields } from './tasks'

/**
 * A key rename, told rather than only resolved (CROFT-264).
 *
 * AC became HOL. Resolution already worked; what was missing was every surface
 * saying so, and the page claiming "(was AC-114)" for a task filed after the
 * rename — a ref nobody ever wrote down.
 */

const RETIRED = '2026-09-22T07:58:11.000Z'

describe('formerRefsOf', () => {
  const former = [{ key: 'AC', retired_at: RETIRED }]

  it('lists the old ref of a task that existed when the key was retired', () => {
    expect(formerRefsOf({ number: 113, created_at: '2026-09-01T00:00:00Z' }, former)).toEqual(['AC-113'])
  })

  it('claims nothing for a task created after the rename', () => {
    // HOL-114 was filed the day after; AC-114 never existed.
    expect(formerRefsOf({ number: 114, created_at: '2026-09-23T00:00:00Z' }, former)).toEqual([])
  })

  it('keeps each rename it lived through, and only those', () => {
    const twice = [
      { key: 'AA', retired_at: '2026-01-01T00:00:00Z' },
      { key: 'AC', retired_at: RETIRED },
    ]
    expect(formerRefsOf({ number: 7, created_at: '2025-12-01T00:00:00Z' }, twice)).toEqual(['AA-7', 'AC-7'])
    expect(formerRefsOf({ number: 8, created_at: '2026-05-01T00:00:00Z' }, twice)).toEqual(['AC-8'])
  })

  it('falls back to every former key when the creation time is unknown', () => {
    expect(formerRefsOf({ number: 1 }, former)).toEqual(['AC-1'])
  })
})

describe('issuedUnderFormerKey', () => {
  it('is true only for a task that predates the retirement', () => {
    expect(issuedUnderFormerKey({ at: RETIRED }, '2026-09-21T00:00:00Z')).toBe(true)
    expect(issuedUnderFormerKey({ at: RETIRED }, '2026-09-22T09:00:00Z')).toBe(false)
  })
})

describe('recentFormerRefs, for the briefing', () => {
  const now = Date.parse('2026-10-01T00:00:00Z')

  it('shows a rename from the last thirty days', () => {
    expect(
      recentFormerRefs({ number: 113, created_at: '2026-09-01T00:00:00Z' }, [{ key: 'AC', retired_at: RETIRED }], now),
    ).toEqual(['AC-113'])
  })

  it('drops one that is history rather than news', () => {
    expect(
      recentFormerRefs(
        { number: 113, created_at: '2026-01-01T00:00:00Z' },
        [{ key: 'OLD', retired_at: '2026-06-01T00:00:00Z' }],
        now,
      ),
    ).toEqual([])
  })
})

describe('what a task response says about its ref', () => {
  const rename = { key: 'AC', to: 'HOL', at: RETIRED, by: 'claude-code · cal@example.test' }

  it('adds requested_ref and renamed_from only when a retired key was used', () => {
    expect(renameFields({ renamed: null, requestedRef: 'HOL-113' })).toEqual({})
    expect(renameFields({ renamed: rename, requestedRef: 'AC-113' })).toEqual({
      requested_ref: 'AC-113',
      renamed_from: rename,
    })
  })

  it('names the live ref when the old one was never issued', () => {
    const message = noSuchTaskMessage('AC-114', {
      task: null,
      renamed: rename,
      requestedRef: 'AC-114',
      neverIssued: 'HOL-114',
    })
    expect(message).toBe(
      'No task AC-114. Project AC was renamed HOL on 2026-09-22, and HOL-114 was created after that, ' +
        'so AC-114 was never issued. Did you mean HOL-114?',
    )
  })

  it('keeps the plain message when no rename was involved', () => {
    expect(noSuchTaskMessage('NOPE-1', { task: null, renamed: null, requestedRef: 'NOPE-1' })).toBe(
      'No task NOPE-1.',
    )
  })
})

/**
 * A pool that answers by table, so the live-then-retired lookup order can be
 * exercised without Postgres.
 */
type Tables = { projects: Record<string, unknown>[]; project_former_keys: Record<string, unknown>[] }
const scope = globalThis as typeof globalThis & { __croftPool?: unknown; __croftJsonColumns?: unknown }
let prior: { pool: unknown; json: unknown }
let statements: { sql: string; values: unknown[] }[] = []

const install = (tables: Tables) => {
  statements = []
  scope.__croftJsonColumns = Promise.resolve(new Set<string>())
  scope.__croftPool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values })
        const table = /from "project_former_keys"/.test(sql) ? 'project_former_keys' : 'projects'
        const rows = tables[table].filter((row) => {
          if (/\."key" = \$1/.test(sql)) return row.key === values[0]
          if (/\."id" = \$1/.test(sql)) return row.id === values[0]
          if (/\."key" in/.test(sql)) return (values as unknown[]).includes(row.key)
          return true
        })
        return { rows, rowCount: rows.length }
      },
      release: () => {},
    }),
  }
}

beforeEach(() => {
  prior = { pool: scope.__croftPool, json: scope.__croftJsonColumns }
})
afterEach(() => {
  scope.__croftPool = prior.pool
  scope.__croftJsonColumns = prior.json
})

const TABLES: Tables = {
  projects: [{ id: 'id-hol', key: 'HOL', title: 'Holloway' }],
  project_former_keys: [
    { key: 'AC', project_id: 'id-hol', retired_at: RETIRED, retired_by: 'claude-code · cal@example.test' },
  ],
}

describe('resolving a project key', () => {
  it('a live key resolves with no rename and never consults the retired keys', async () => {
    install(TABLES)
    const resolved = await resolveProject('hol')
    expect(resolved).toMatchObject({ project: { id: 'id-hol', key: 'HOL' }, renamed: null })
    expect(statements.some((s) => s.sql.includes('project_former_keys'))).toBe(false)
  })

  it('a retired key resolves to the live project and says how', async () => {
    install(TABLES)
    const resolved = await resolveProject('AC')
    expect(resolved?.project).toMatchObject({ id: 'id-hol', key: 'HOL' })
    expect(resolved?.renamed).toEqual({
      key: 'AC',
      to: 'HOL',
      at: RETIRED,
      by: 'claude-code · cal@example.test',
    })
  })

  it('a key nobody ever had is still nothing', async () => {
    install(TABLES)
    expect(await resolveProject('NOPE')).toBeNull()
    expect(await lookupFormerKey('NOPE')).toBeNull()
  })

  it('a filter on a retired key becomes the live key', async () => {
    install(TABLES)
    expect(await liveProjectKey('ac')).toMatchObject({ key: 'HOL', renamed: { key: 'AC', to: 'HOL' } })
    expect(await liveProjectKey('HOL')).toEqual({ key: 'HOL', renamed: null })
    // Unknown stays as it was, so each route keeps its own answer for a typo.
    expect(await liveProjectKey('NOPE')).toEqual({ key: 'NOPE', renamed: null })
    expect(await liveProjectKey(undefined)).toEqual({ key: undefined, renamed: null })
  })

  it('several keys at once, retired ones included', async () => {
    install(TABLES)
    const { found, missing, renamed } = await projectsForKeys(['ac', 'hol', 'nope'])
    expect(found.get('AC')).toEqual({ id: 'id-hol', key: 'HOL' })
    expect(found.get('HOL')).toMatchObject({ id: 'id-hol', key: 'HOL' })
    expect(missing).toEqual(['NOPE'])
    expect(renamed.map((r) => r.key)).toEqual(['AC'])
  })
})

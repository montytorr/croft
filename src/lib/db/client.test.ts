import { describe, expect, it } from 'vitest'
import { admin, bind, normalizeDatabaseValue } from './client'
import { withFakePool } from './fake-pool'

describe('normalizeDatabaseValue', () => {
  it('preserves the former PostgREST timestamp contract for nested results', () => {
    const at = new Date('2026-09-12T07:04:18.535Z')

    expect(normalizeDatabaseValue({ at, nested: [{ ended_at: at }], value: 3 })).toEqual({
      at: '2026-09-12T07:04:18.535Z',
      nested: [{ ended_at: '2026-09-12T07:04:18.535Z' }],
      value: 3,
    })
  })
})

describe('bind', () => {
  const json = new Set(['sessions.files', 'task_activity_events.data'])

  it('serialises an array bound for a json column', () => {
    // Left alone, node-postgres writes the Postgres array literal {a,b},
    // which jsonb rejects — so every session that touched a file failed to
    // record at all.
    expect(bind('sessions', 'files', ['src/a.ts', 'src/b.ts'], json)).toBe('["src/a.ts","src/b.ts"]')
  })

  it('serialises an EMPTY array bound for a json column', () => {
    // The quiet half of the same bug: [] became the literal {}, which is
    // valid JSON for an *object*, so it was stored without complaint and the
    // column stopped holding arrays.
    expect(bind('sessions', 'files', [], json)).toBe('[]')
  })

  it('serialises an object bound for a json column', () => {
    expect(bind('task_activity_events', 'data', { reason: 'reconcile' }, json)).toBe(
      '{"reason":"reconcile"}',
    )
  })

  it('leaves a real Postgres array alone', () => {
    // task_refs is text[], and an array literal is exactly right for it.
    expect(bind('sessions', 'task_refs', ['AT-1', 'AT-2'], json)).toEqual(['AT-1', 'AT-2'])
  })

  it('passes scalars, dates and null through untouched', () => {
    const now = new Date()
    expect(bind('sessions', 'files', null, json)).toBeNull()
    expect(bind('sessions', 'tool_calls', 42, json)).toBe(42)
    expect(bind('sessions', 'started_at', now, json)).toBe(now)
  })
})

describe('upsert SQL', () => {
  /**
   * CROFT-238: `croft entities assign` was dead because the project_entities
   * upsert passed no options at all. Fixing the call site alone would have left
   * the trap in place for the next join table, so both levels are covered here.
   */
  const capture = async (run: () => PromiseLike<unknown>) =>
    (await withFakePool(run)).statements

  it('says "do nothing" when every column is a conflict column', async () => {
    // project_entities is nothing but its pair, so there is no column left to
    // set. `do update set` with an empty list is a syntax error.
    const [sql] = await capture(() =>
      admin()
        .from('project_entities')
        .upsert([{ project_id: 'p1', entity_id: 'e1' }], {
          onConflict: 'project_id,entity_id',
          ignoreDuplicates: true,
        }),
    )

    expect(sql).toContain('on conflict ("project_id", "entity_id")')
    expect(sql).toContain('do nothing')
    expect(sql).not.toContain('do update set')
  })

  it('says "do nothing" for an all-key upsert even without ignoreDuplicates', async () => {
    // The guard that stops the next join table repeating CROFT-238.
    const [sql] = await capture(() =>
      admin()
        .from('project_entities')
        .upsert([{ project_id: 'p1', entity_id: 'e1' }], { onConflict: 'project_id,entity_id' }),
    )

    expect(sql).toContain('do nothing')
    expect(sql).not.toContain('do update set')
  })

  it('returns only the rows a do-nothing upsert really inserted', async () => {
    // CROFT-240: `added` counted the ids it asked for, so a re-assign that
    // wrote nothing still reported 1. RETURNING after `do nothing` yields only
    // the genuinely inserted rows, which is the honest count.
    const { statements, result } = await withFakePool(
      () =>
        admin()
          .from('project_entities')
          .upsert([{ project_id: 'p1', entity_id: 'e1' }], {
            onConflict: 'project_id,entity_id',
            ignoreDuplicates: true,
          })
          .select('project_id'),
      [],
    )

    expect(statements[0]).toContain('do nothing returning "project_id"')
    expect((result as { data: unknown[] }).data).toEqual([])
  })

  it('still updates the columns outside the key', async () => {
    const [sql] = await capture(() =>
      admin()
        .from('project_repos')
        .upsert([{ project_id: 'p1', remote: 'git@x:y.git', root_commit: 'abc' }], {
          onConflict: 'project_id,remote',
        }),
    )

    expect(sql).toContain('do update set "root_commit" = excluded."root_commit"')
    expect(sql).not.toContain('"project_id" = excluded."project_id"')
  })

  it('still refuses an upsert with no conflict columns at all', async () => {
    // Returned as an error result rather than thrown -- which is why the CLI
    // printed a bare "upsert requires onConflict" with no stack behind it.
    let result: { error: { message: string } | null } | undefined
    const statements = await capture(async () => {
      result = (await admin()
        .from('project_entities')
        .upsert([{ project_id: 'p1' }])) as typeof result
    })

    expect(result?.error?.message).toBe('upsert requires onConflict')
    expect(statements).toEqual([])
  })
})

describe('is filters', () => {
  const capture = async (run: () => PromiseLike<unknown>) =>
    (await withFakePool(run)).statements

  it('negates .not(column, "is", null) into IS NOT NULL', async () => {
    // CROFT-272: the negation was dropped, so this ran as IS NULL and the
    // sessions agent filter, the cwd project fallback and stale claims all
    // read the opposite rows.
    const [sql] = await capture(() =>
      admin().from('sessions').select('agent_id').not('agent_id', 'is', null),
    )

    expect(sql).toContain('"agent_id" is not null')
  })

  it('keeps .is(column, null) as IS NULL', async () => {
    const [sql] = await capture(() => admin().from('sessions').select('agent_id').is('agent_id', null))

    expect(sql).toContain('"agent_id" is null')
  })
})

describe('not filters', () => {
  it('unquotes a PostgREST quoted list, so done tasks stay out of croft next', async () => {
    // CROFT-272: '("done","cancelled")' was bound as '"done"', which no status
    // equals, so the NOT IN excluded nothing.
    const { statements, parameters } = await withFakePool(() =>
      admin().from('tasks').select('id').not('status', 'in', '("done","cancelled")'),
    )

    expect(statements[0]).toContain('"status" not in ($1, $2)')
    expect(parameters[0]).toEqual(['done', 'cancelled'])
  })

  it('translates a PostgREST operator name into SQL', async () => {
    const [sql] = (
      await withFakePool(() => admin().from('tasks').select('id').not('status', 'eq', 'done'))
    ).statements

    expect(sql).toContain('not (b."status" = $1)')
  })
})

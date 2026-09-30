import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : []
  })

describe('shared workspace boundaries', () => {
  it('does not treat legacy owner columns as source authorization filters', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src'))
      .filter((path) => {
        const source = readFileSync(path, 'utf8')
        return (
          source.includes(".eq('owner_user_id'") ||
          source.includes('.eq("owner_user_id"') ||
          source.includes(".eq('projects.owner_user_id'") ||
          source.includes(".eq('tasks.projects.owner_user_id'")
        )
      })
      .map((path) => path.replace(`${process.cwd()}/`, ''))

    expect(offenders, `owner-scoped workspace queries remain: ${offenders.join(', ')}`).toEqual([])
  })

  it('makes shared public identifiers globally unique', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/047_shared_workspace_boundaries.sql'),
      'utf8',
    )

    expect(migration).toContain('projects_key_unique_workspace on projects (key)')
    expect(migration).toContain('entities_key_unique_workspace on entities (key)')
    expect(migration).toContain('knowledge_slug_unique_workspace on knowledge (slug)')
    expect(migration).toContain('alter table project_former_keys add primary key (key)')
  })

  it('migrates every owner-scoped workspace RPC without changing its signature', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/048_shared_workspace_rpcs.sql'),
      'utf8',
    )
    for (const name of [
      'search_tasks',
      'search_all',
      'activity_feed',
      'list_labels',
      'rename_label',
      'croft_pulse',
      'croft_work_shape',
      'croft_memory_use',
      'croft_vitals',
    ]) {
      expect(migration, `shared migration omits ${name}`).toContain(`'${name}'`)
    }
    expect(migration).toContain("raise exception 'owner predicate remains in function %'")
    expect(migration).toContain("raise exception 'expected 9 workspace RPCs, found %'")
  })

  it('qualifies every legacy attribution surface before users share one workspace', () => {
    const migration = readFileSync(
      join(process.cwd(), 'migrations/049_shared_workspace_attribution.sql'),
      'utf8',
    )

    for (const statement of [
      'update tasks t',
      'set actor_id = croft_qualify_legacy_actor(t.actor_type',
      'claimed_by = case',
      'resolved_by = case',
      'update task_notes n',
      'update task_comments c',
      'update task_attachments a',
      'update task_activity_events e',
      'update knowledge k',
      'update sessions s',
      'update search_events s',
    ]) {
      expect(migration, `legacy attribution migration omits ${statement}`).toContain(statement)
    }
  })

  it('does not relabel every human note or comment as the current viewer', () => {
    for (const path of [
      'src/app/(app)/projects/[key]/tasks/[number]/notes-panel.tsx',
      'src/app/(app)/projects/[key]/tasks/[number]/comments-panel.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      expect(source, `${path} still hides shared human attribution behind “you”`).not.toMatch(
        /actor_type\s*===\s*['"]agent['"]\s*\?\s*\w+\.actor_id\s*:\s*['"]you['"]/,
      )
    }
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release validation boundary', () => {
  it('allows production deploy only after the main CI workflow succeeds', () => {
    const deploy = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf8')
    expect(deploy).toContain('workflow_run:')
    expect(deploy).toContain('workflows: [ci]')
    expect(deploy).toContain("workflow_run.conclusion == 'success'")
    expect(deploy).toContain("workflow_run.event == 'push'")
    expect(deploy).toContain("workflow_run.head_branch == 'main'")
    expect(deploy).toContain('workflow_run.head_repository.full_name == github.repository')
    expect(deploy).not.toContain('workflow_dispatch:')
    expect(deploy).not.toMatch(/\n\s+push:\s*\n/)

    const workflowRun = {
      conclusion: 'success', event: 'pull_request', head_branch: 'main',
      head_repository: { full_name: 'attacker/croft' },
    }
    const repository = 'montytorr/croft'
    const canDeploy = workflowRun.conclusion === 'success' &&
      workflowRun.event === 'push' &&
      workflowRun.head_branch === 'main' &&
      workflowRun.head_repository.full_name === repository
    expect(canDeploy).toBe(false)
  })

  it('deploys only the commit main is on, so a late CI run cannot roll it back (CROFT-318)', () => {
    const deploy = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf8')
    expect(deploy).toMatch(/\n  gate:\n/)
    expect(deploy).toContain('repos/$REPO/commits/main')
    expect(deploy).toMatch(/\n  deploy:\n    needs: gate\n    if: needs\.gate\.outputs\.current == 'true'/)
  })

  it('makes PostgreSQL integrity coverage a blocking CI job', () => {
    const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('image: postgres:16')
    expect(ci).toContain('npm run db:migrate')
    expect(ci).toContain('npm run test:integration')
  })
})

import { describe, expect, it } from 'vitest'
import { checkoutName, projectKeyForCheckoutName, repoName } from './project-resolution'

/** Absolute fixture paths, built so no real home directory is spelled out. */
const p = (...parts: string[]) => ['', ...parts].join('/')

/**
 * The server's last resort for a session that arrives with neither a project
 * nor a remote (CROFT-286). It is inference, so the ambiguity rule is the part
 * worth pinning: one project answers, or none does.
 */
describe('attributing a session by its checkout name', () => {
  const rows = [
    { remote: 'github.com/montytorr/croft', project: { key: 'CROFT' } },
    { remote: 'github.com/montytorr/hermes', project: [{ key: 'HERMES' }] },
    { remote: 'github.com/a/api', project: { key: 'AAPI' } },
    { remote: 'github.com/b/api', project: { key: 'BAPI' } },
  ]

  it('reads the directory a checkout was cloned into', () => {
    expect(checkoutName(p('home', 'dev', 'croft'))).toBe('croft')
    expect(checkoutName(`${p('srv', 'projects', 'croft')}/`)).toBe('croft')
    expect(checkoutName(p('Users', 'dev', 'Hermes'))).toBe('hermes')
  })

  it('treats a worktree as its parent checkout', () => {
    expect(checkoutName(p('Users', 'dev', 'code', 'croft', '.claude', 'worktrees', 'agent-a1'))).toBe('croft')
    expect(checkoutName(p('Users', 'dev', 'croft', '.worktrees', 'fix-x'))).toBe('croft')
  })

  it('names a repository by the last segment of its remote, however it is spelled', () => {
    expect(repoName('git@github.com:montytorr/croft.git')).toBe('croft')
    expect(repoName('https://github.com/montytorr/Croft/')).toBe('croft')
  })

  it('answers when exactly one project has a repository by that name', () => {
    expect(projectKeyForCheckoutName(rows, 'croft')).toBe('CROFT')
    expect(projectKeyForCheckoutName(rows, 'hermes')).toBe('HERMES')
  })

  it('refuses to guess between two projects', () => {
    expect(projectKeyForCheckoutName(rows, 'api')).toBeNull()
  })

  it('answers once when one project lists the same name twice', () => {
    const twice = [...rows, { remote: 'gitlab.com/mirror/croft', project: { key: 'CROFT' } }]
    expect(projectKeyForCheckoutName(twice, 'croft')).toBe('CROFT')
  })

  it('answers nothing for a directory no repository is named after', () => {
    expect(projectKeyForCheckoutName(rows, 'dev')).toBeNull()
    expect(projectKeyForCheckoutName(rows, null)).toBeNull()
  })
})

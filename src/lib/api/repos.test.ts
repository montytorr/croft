import { describe, expect, it } from 'vitest'
import { normaliseRemote, projectKeyFromRepoRows } from './repos'

describe('normaliseRemote', () => {
  it('resolves the ssh and https spellings of one repo to the same string', () => {
    // The whole point: a clone made either way must reach the same row.
    expect(normaliseRemote('git@github.com:montytorr/croft.git')).toBe('github.com/montytorr/croft')
    expect(normaliseRemote('https://github.com/montytorr/croft.git')).toBe(
      'github.com/montytorr/croft',
    )
  })

  it('drops credentials, so a tokenised remote is not a different repository', () => {
    expect(normaliseRemote('https://thierry:ghp_secret@github.com/montytorr/croft.git')).toBe(
      'github.com/montytorr/croft',
    )
  })

  it('drops a port, which is transport and not identity', () => {
    expect(normaliseRemote('ssh://git@github.com:22/montytorr/croft.git')).toBe(
      'github.com/montytorr/croft',
    )
  })

  it('ignores case and a trailing slash', () => {
    expect(normaliseRemote('https://GitHub.com/MontyTorr/Croft/')).toBe(
      'github.com/montytorr/croft',
    )
  })

  it('is not fooled by a path segment that looks like a port', () => {
    // scp-style has no port: the colon is the path separator, and a group may
    // legitimately be named in digits. Reading `4242` as a port dropped it and
    // merged every repo under that group into one identity.
    expect(normaliseRemote('git@gitlab.com:4242/repo.git')).toBe('gitlab.com/4242/repo')
    // A URL does have one, and it still goes.
    expect(normaliseRemote('ssh://git@gitlab.com:2222/4242/repo.git')).toBe('gitlab.com/4242/repo')
  })

  it('reduces a remote carrying both .git and a trailing slash', () => {
    // The suffixes were stripped in the order that leaves `.git` behind, so
    // one repository got two identities depending on a trailing slash.
    expect(normaliseRemote('git@github.com:montytorr/croft.git/')).toBe('github.com/montytorr/croft')
    expect(normaliseRemote('https://github.com/montytorr/croft.git/')).toBe(
      'github.com/montytorr/croft',
    )
  })

  it('leaves a host it does not recognise alone rather than guessing', () => {
    expect(normaliseRemote('git@gitlab.com:webcoder31/adhaf.git')).toBe(
      'gitlab.com/webcoder31/adhaf',
    )
  })
})

describe('projectKeyFromRepoRows', () => {
  it('resolves when exactly one project claims the repository', () => {
    expect(projectKeyFromRepoRows([{ project: { key: 'CAI' } }])).toBe('CAI')
  })

  it('resolves to nothing when the repository is unknown', () => {
    expect(projectKeyFromRepoRows([])).toBeNull()
  })

  it('reads the embed whether PostgREST returns an object or a one-row array', () => {
    // The sibling lookup in context.ts has to do the same dance; the shape
    // depends on how the relationship is inferred, not on the data.
    expect(projectKeyFromRepoRows([{ project: [{ key: 'CAI' }] }])).toBe('CAI')
  })

  it('refuses to choose when several projects claim the repository', () => {
    // A monorepo split across projects matches twice. Picking the first would
    // be silently wrong for months; falling through lets the caller answer.
    expect(
      projectKeyFromRepoRows([{ project: { key: 'CAI' } }, { project: { key: 'WEB' } }]),
    ).toBeNull()
  })
})

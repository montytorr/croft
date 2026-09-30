/**
 * Repository identity, which is what "which project is this?" really asks.
 *
 * A path answers where one machine keeps a checkout; it changes under a second
 * clone, a `mv` and a `git worktree`, none of which change the repository. The
 * remote does not, and it costs one local git call to read.
 */

/**
 * git@github.com:montytorr/croft.git, https://github.com/montytorr/croft.git
 * and https://user:token@github.com/montytorr/croft/ are one repository.
 *
 * Normalising on the server keeps the rule in one place, so the CLI, the MCP
 * facade and an import all reach the same row. Everything stripped here is
 * transport — how this checkout reaches the repo — rather than identity.
 */
export const normaliseRemote = (raw: string): string => {
  const trimmed = raw.trim()
  // Whether a port is even a possibility is decided by the spelling, so it has
  // to be read before the scheme is stripped.
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)

  const hostAndPath = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
    .replace(/^[^@/]+@/, '') // credentials, or the ssh user

  const withoutTransport = isUrl
    ? // A port only exists in a URL.
      hostAndPath.replace(/:\d+(?=\/|$)/, '')
    : // In scp-style `host:path` the colon is the path separator, and a path
      // may legitimately begin with digits — a GitLab group named 4242 is a
      // path, not a port. Reading it as one merged two repositories into one
      // identity, which is the exact failure this function exists to prevent.
      hostAndPath.replace(/:/, '/')

  return (
    withoutTransport
      // Before `.git`, not after: `…/croft.git/` has both, and stripping them
      // in the other order left the suffix behind, so one repository got two
      // identities depending on a trailing slash.
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
      .toLowerCase()
  )
}

export type RepoRow = { project: { key: string } | { key: string }[] | null }

/**
 * Reads the project key out of a PostgREST embed, whose shape depends on how
 * the relationship was inferred rather than on the data.
 *
 * Ambiguity is left unresolved on purpose. A monorepo whose subdirectories are
 * separate projects matches more than once, and guessing between them would be
 * silently wrong for months; returning nothing lets the caller's own answer —
 * an explicit `--project`, or the local map — decide instead.
 */
export const projectKeyFromRepoRows = (rows: RepoRow[]): string | null => {
  const row = rows.length === 1 ? rows[0] : undefined
  if (!row) return null
  return projectKeyFromEmbed(row.project)
}

/** The same unwrap, for callers holding a single row. */
export const projectKeyFromEmbed = (embedded: RepoRow['project']): string | null =>
  (Array.isArray(embedded) ? embedded[0]?.key : embedded?.key) ?? null

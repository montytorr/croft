import { admin } from '@/lib/db/client'
import { normaliseRemote, projectKeyFromEmbed, projectKeyFromRepoRows, type RepoRow } from './repos'

/**
 * Which project a working directory belongs to, from what the server holds.
 *
 * The caller knows its filesystem and should say — `croft context` sends the
 * local map's answer and the checkout's remote. These are the fallbacks for
 * when it does not.
 */

/**
 * Which project a repository belongs to.
 *
 * Preferred over the checkout-name heuristic below because it is evidence rather than
 * inference: the remote is the same string in every clone and every worktree,
 * where a path is true of one machine only.
 */
export const projectForRepo = async (_userId: string, remote: string): Promise<string | null> => {
  const { data, error } = await admin()
    .from('project_repos')
    .select('project:projects(key)')
    .eq('remote', normaliseRemote(remote))
    // Two is enough to know it is ambiguous, and cheaper than counting.
    .limit(2)

  if (error) throw new Error(error.message)
  return projectKeyFromRepoRows((data ?? []) as unknown as RepoRow[])
}

/**
 * The directory a checkout was cloned into, which is the repository's name
 * unless someone chose otherwise. A worktree under `.claude/worktrees/<name>`
 * or `.worktrees/<name>` is its parent checkout.
 */
export const checkoutName = (cwd: string): string | null => {
  const trimmed = cwd
    .replace(/\/+$/, '')
    .replace(/\/\.(?:claude\/)?worktrees\/[^/]+$/, '')
  return trimmed.split('/').pop()?.toLowerCase() || null
}

export const repoName = (remote: string): string | null =>
  normaliseRemote(remote).split('/').pop() || null

/**
 * A key out of repository rows whose name matches a checkout — only when
 * exactly one project answers. Pure, so the ambiguity rule is tested.
 */
export const projectKeyForCheckoutName = (
  rows: (RepoRow & { remote: string })[],
  name: string | null,
): string | null => {
  if (!name) return null
  const keys = new Set(
    rows
      .filter((row) => repoName(row.remote) === name)
      .map((row) => projectKeyFromEmbed(row.project))
      .filter((key): key is string => Boolean(key)),
  )
  return keys.size === 1 ? ([...keys][0] ?? null) : null
}

/**
 * The last resort, for a caller that sent neither a project nor a remote: an
 * older CLI, or a recorder whose cwd has no git in reach. A server checkout
 * such as `~/croft` is a checkout of `github.com/montytorr/croft`, and nothing else on the
 * server says so.
 *
 * Inference, so it only answers when one project does. Two projects with a
 * repository called `api` leave the directory unattributed, which is honest; a
 * guess between them would be silently wrong for months.
 */
export const projectForCheckoutName = async (_userId: string, cwd: string): Promise<string | null> => {
  const name = checkoutName(cwd)
  if (!name) return null
  const { data, error } = await admin()
    .from('project_repos')
    .select('remote, project:projects(key)')
  if (error) throw new Error(error.message)
  return projectKeyForCheckoutName((data ?? []) as unknown as (RepoRow & { remote: string })[], name)
}

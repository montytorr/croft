import { fail } from './response'
import type { Actor } from './auth'
import { bodyProblems } from '@/lib/markdown-body'

/**
 * Refuses an agent's task body that would be a wall of text (CROFT-312).
 *
 * Here rather than in the CLI for the reason CROFT-291 moved the bug/spike
 * rule: this is where every caller meets it — the CLI, the MCP server that
 * shells it, and anything talking HTTP directly. Agents only: a person typing
 * into the board's editor is looking at the result as they write it, and a
 * refusal there would cost more than it saves.
 *
 * `error` carries the list as well as `problems`, because a client that only
 * prints `error` — an older CLI copy, a hand-rolled script — still gets
 * something it can act on.
 *
 * @param retry the command that sends a corrected body, shown to the caller.
 */
export const refuseUnreadableBody = (
  actor: Pick<Actor, 'actorType'>,
  description: string | null | undefined,
  retry: string,
): Response | null => {
  if (actor.actorType !== 'agent' || !description) return null
  const problems = bodyProblems(description)
  if (problems.length === 0) return null
  return fail(
    'validation_failed',
    'This description is hard to read as written, so it was not saved. Task bodies are markdown: ' +
      `fix each point below and send it again. \`${retry}\` reads the body from stdin, so real ` +
      'line breaks and backticks survive the shell.\n' +
      problems.map((p) => `  - ${p}`).join('\n'),
    { field: 'description', problems },
  )
}

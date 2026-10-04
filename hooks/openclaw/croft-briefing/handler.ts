/**
 * OpenClaw's half of "brief the agent at session start".
 *
 * OpenClaw has no session-start hook that can return text. What it has is
 * `agent:bootstrap`, fired before the workspace's bootstrap files are injected,
 * with `context.bootstrapFiles` open to mutation. So the briefing arrives as
 * one more bootstrap file: the one rule, then `croft context --brief` for the
 * agent's workspace (five lines at most).
 *
 * Same rules as hooks/croft-context.mjs: never block (a 3 s deadline, and every
 * failure leaves the session starting as it would have without this hook), and
 * stay small. Unlike that hook it still injects the rule when the CLI fails,
 * because an agent that cannot reach Croft should still know when to use it.
 *
 * No imports from OpenClaw: the hook is linked from outside its tree, so the
 * types below are the subset of its documented event this reads.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'

type BootstrapFile = { name: string; path: string; content?: string; missing: boolean }

type HookEvent = {
  type: string
  action: string
  context?: { workspaceDir?: unknown; bootstrapFiles?: unknown }
}

export const FILE_NAME = 'CROFT.md'

export const RULE = `## Croft — the lab
Lab work (exploring, proving an idea, a subject's todos) → Croft: croft check first. Croft holds lab work only.`

const timeoutMs = () => {
  const value = Number(process.env.CROFT_HOOK_TIMEOUT_MS ?? 3000)
  return Number.isFinite(value) && value > 0 ? value : 3000
}

/** `croft context --brief` for the workspace, or '' on any failure, never slower than the deadline. */
export const briefing = (cwd: string): Promise<string> =>
  new Promise((resolve) => {
    const cli = process.env.CROFT_CLI?.trim() || 'croft'
    try {
      execFile(
        cli,
        ['context', '--brief', '--cwd', cwd],
        {
          cwd,
          timeout: timeoutMs(),
          maxBuffer: 1024 * 1024,
          env: { ...process.env, CROFT_AGENT: process.env.CROFT_AGENT || 'openclaw' },
        },
        (error, stdout) => resolve(error ? '' : String(stdout).trim()),
      )
    } catch {
      resolve('')
    }
  })

const handler = async (event: HookEvent): Promise<void> => {
  if (event?.type !== 'agent' || event.action !== 'bootstrap') return
  const context = event.context
  if (!context || typeof context.workspaceDir !== 'string' || !Array.isArray(context.bootstrapFiles)) return

  try {
    const workspaceDir = context.workspaceDir
    const live = await briefing(workspaceDir)
    const files = (context.bootstrapFiles as BootstrapFile[]).filter((f) => f?.name !== FILE_NAME)
    files.push({
      name: FILE_NAME,
      path: join(workspaceDir, FILE_NAME),
      content: live ? `${RULE}\n\n${live}` : RULE,
      missing: false,
    })
    context.bootstrapFiles = files
  } catch {
    // Fail open: the session starts exactly as it would have without this hook.
  }
}

export default handler

#!/usr/bin/env node
/**
 * Croft's SessionStart briefing: a few lines about the lab, or nothing.
 *
 * Reads a hook payload on stdin, runs `croft context --brief --cwd <cwd>` and
 * prints the runtime's context response. Claude Code and Codex share a wire
 * format. Hermes Agent by Nous Research injects context from `pre_llm_call`,
 * whose response protocol is different.
 *
 *   1. Never block. Every failure path prints nothing and exits 0, and the CLI
 *      gets a hard deadline.
 *   2. Never speak when there is nothing to say.
 *   3. Stay small. The CLI's --brief prints five lines at most.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const TIMEOUT_MS = Number(process.env.CROFT_HOOK_TIMEOUT_MS ?? 3000)

/**
 * `croft setup` installs the CLI to ~/.local/bin, and a runtime launched from
 * a dock or an IDE often has no PATH entry for it. A PATH miss looks exactly
 * like "nothing to say", so the hook would go quiet for good without a word.
 */
const cli = () => {
  if (process.env.CROFT_CLI) return process.env.CROFT_CLI
  if ((process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, 'croft')))) return 'croft'
  const local = join(homedir(), '.local', 'bin', 'croft')
  return existsSync(local) ? local : 'croft'
}
const CLI = cli()

/**
 * A summariser run (ours, or any agent-memory tool's, which sets the shared
 * flag) is a headless model call started by a hook. Briefing it wastes its
 * context and, worse, can leak into what it summarises.
 */
const SUMMARISER_ENVS = ['AGENT_MEMORY_SUMMARISER', 'CROFT_SUMMARISER']

const readStdin = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

/**
 * Runs the CLI with a hard deadline, and treats every failure as "say nothing".
 * `context --brief` is itself silent on every failure, including a machine
 * with several instances and no route for this directory: the first real
 * command there says what to ask, and a briefing is no place for it.
 */
const run = (args) =>
  new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      child = spawn(CLI, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      done('')
      return
    }
    // A grandchild the CLI left behind could hold the pipe open past the
    // kill; letting go of it is what keeps the deadline a deadline.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      child.stdout.destroy()
      child.unref()
      done('')
    }, TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('error', () => {
      clearTimeout(timer)
      done('')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 ? out : '')
    })
  })

const main = async () => {
  if (SUMMARISER_ENVS.some((name) => process.env[name])) return

  const payload = await readStdin()
  const event = payload.hook_event_name ?? 'SessionStart'
  const cwd = payload.cwd ?? process.cwd()

  // Hermes invokes pre_llm_call for every turn; its first turn is the
  // session-start equivalent. `extra.is_first_turn` is where v0.21.3 puts it,
  // the top level a fallback. Neither: say so on stderr, which Hermes logs.
  if (event === 'pre_llm_call') {
    const isFirstTurn = payload.extra?.is_first_turn ?? payload.is_first_turn
    if (isFirstTurn === undefined) {
      process.stderr.write('croft: pre_llm_call payload carries no is_first_turn, in extra or at top level — no briefing will ever be injected\n')
      return
    }
    if (isFirstTurn !== true) return
  } else if (event !== 'SessionStart') {
    return
  }

  const text = (await run(['context', '--brief', '--cwd', cwd])).trim()
  if (!text) return

  if (event === 'pre_llm_call') {
    process.stdout.write(`${JSON.stringify({ context: text })}\n`)
    return
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
      suppressOutput: true,
    })}\n`,
  )
}

main().catch(() => {})

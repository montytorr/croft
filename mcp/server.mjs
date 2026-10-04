#!/usr/bin/env node
/**
 * MCP facade over the `croft` CLI.
 *
 * It holds ZERO logic. Every tool shells out to the same binary a human or a
 * shell-capable agent would run, so there is exactly one implementation of
 * every behaviour. Anything that ends up here and not in the CLI is a bug.
 *
 * Croft is a lab board: SUBJECTS (S-12) move through stages and end with a
 * conclusion; their TODOS are tasks (T-41) worked with the task tools below.
 * Deliberately left out: subject edit/tag (do them in the web app or the
 * CLI), handoff/sync (they spawn a tracker's own CLI — run them from a
 * shell), stages/tags admin, and every memory verb (Croft has no memory).
 * A todo handed off to a tracker is refused by the task tools below with
 * `handed_off`; the CLI prints the server's message, which says what to do
 * (work it in the tracker, or take it back), and it reaches the caller as text.
 *
 * Why bother, given the CLI exists: Codex's [mcp_servers.*] gives per-tool
 * timeouts and approval modes, Claude Code enforces the tool schemas so the
 * model cannot invent flags, and OpenClaw can reach it through mcporter.
 *
 * Requires `croft` on PATH, plus CROFT_BASE_URL and CROFT_API_KEY (or
 * ~/.croft/env, which the CLI reads itself).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const run = promisify(execFile)

const CROFT_BIN = process.env.CROFT_BIN || 'croft'

/** Never interpolate into a shell — execFile takes an argv array. */
const croft = async (args) => {
  try {
    const { stdout, stderr } = await run(CROFT_BIN, args, {
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    })
    // stderr as well, ahead of stdout. It carries what the CLI says ABOUT an
    // answer rather than the answer — "AC-113 is now HOL-113, project AC was
    // renamed HOL" (CROFT-264), "nothing found", what a digest withheld — and
    // returning stdout alone meant an MCP caller asked for AC-113, got HOL-113
    // and was never told why. The shell caller always saw both.
    const text = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
    return { text: text || 'ok', isError: false }
  } catch (error) {
    // Exit 9 is the CLI's "another agent holds this". Surface it as text
    // rather than a protocol error, so the model can act on it.
    const detail = [error.stderr, error.stdout].filter(Boolean).join('\n').trim()
    return {
      text: detail || error.message,
      isError: error.code !== 9,
    }
  }
}

const TOOLS = [
  {
    name: 'croft_check',
    description:
      'ALWAYS CALL THIS FIRST, before evaluating or prototyping anything. Returns an ' +
      'index of lab SUBJECTS (S-12), TODOS (T-41) and work-log NOTES — showing what the ' +
      'lab already tried or concluded and roughly what each costs to open. Open a ' +
      'subject row with croft_subject_show and a todo row with croft_show.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What you are about to work on.' },
        assignee: {
          type: 'string',
          description: 'Only tasks assigned to this person: "me", an email, a name or a user id.',
        },
      },
      required: ['subject'],
    },
    run: (a) => [
      'check', a.subject,
      ...(a.assignee ? ['--assignee', a.assignee] : []),
    ],
  },
  {
    name: 'croft_show',
    description:
      'Full detail of one todo, including its resolution if it has one. Takes a todo ' +
      'ref like T-41 — for a subject (S-12) use croft_subject_show.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'e.g. T-41' } },
      required: ['ref'],
    },
    run: (a) => ['show', a.ref],
  },
  {
    name: 'croft_subject_list',
    description:
      'The lab board: subjects with their stage, open/done todo counts, tags and lab project. ' +
      'Archived subjects are left out unless all is true.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'Only this stage, by name, e.g. "exploring".' },
        tag: { type: 'string', description: 'Only subjects carrying this tag.' },
        project: { type: 'string', description: 'Only subjects in this lab project (e.g. "Trig"), or "none".' },
        mine: { type: 'boolean', description: 'Only subjects owned by the human behind this key.' },
        all: { type: 'boolean', description: 'Include archived subjects.' },
      },
    },
    run: (a) => [
      'subject', 'list',
      ...(a.stage ? ['--stage', a.stage] : []),
      ...(a.tag ? ['--tag', a.tag] : []),
      ...(a.project ? ['--project', a.project] : []),
      ...(a.mine ? ['--mine'] : []),
      ...(a.all ? ['--all'] : []),
    ],
  },
  {
    name: 'croft_subject_show',
    description:
      'One subject: its write-up, stage, conclusion, tags, todos and work log. A digest ' +
      'unless full is true.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'e.g. S-12' },
        full: { type: 'boolean', description: 'Everything, not a digest.' },
      },
      required: ['ref'],
    },
    run: (a) => ['subject', 'show', a.ref, ...(a.full ? ['--full'] : [])],
  },
  {
    name: 'croft_subject_add',
    description:
      'File a new subject on the lab board: a technology to evaluate, a POC, an idea to ' +
      'prove before it becomes real work. Call croft_check first — the lab may already ' +
      'have concluded on it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: {
          type: 'string',
          description: 'Markdown write-up: the question, why it matters, what would settle it.',
        },
        stage: { type: 'string', description: 'Stage name; defaults to the first planned stage.' },
        tags: { type: 'string', description: 'Comma-separated tag names (croft tags lists them).' },
        project: { type: 'string', description: 'The lab project it is part of, e.g. "Trig" (croft projects lists them).' },
        owner: { type: 'string', description: '"me" to own it yourself.' },
        visibility: {
          type: 'string',
          enum: ['lab', 'members', 'private'],
          description:
            'Who sees it. "lab" (the default): everyone. "members": its owner and the people in members. ' +
            '"private": its owner only. Publishing to the lab later is one-way.',
        },
        members: {
          type: 'string',
          description: 'Comma-separated people to share it with (me, emails or names; croft people lists them). Needs visibility "members".',
        },
      },
      required: ['title'],
    },
    run: (a) => [
      'subject', 'add', a.title,
      ...(a.body ? ['--body', a.body] : []),
      ...(a.stage ? ['--stage', a.stage] : []),
      ...(a.tags ? ['--tag', a.tags] : []),
      ...(a.project ? ['--project', a.project] : []),
      ...(a.owner ? ['--owner', a.owner] : []),
      ...(a.visibility ? ['--visibility', a.visibility] : []),
      ...(a.members ? ['--member', a.members] : []),
    ],
  },
  {
    name: 'croft_subject_stage',
    description:
      'Move a subject to another stage. Entering a concluding stage (done, rejected, ' +
      'rolled out) REQUIRES a conclusion unless the subject already has one: if the ' +
      'answer says conclusion_required, call again with conclusion set to what the lab ' +
      'found and why.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'e.g. S-12' },
        stage: { type: 'string', description: 'Stage name, e.g. "implementing".' },
        conclusion: {
          type: 'string',
          description: 'What was concluded, and why — the answer the next person reads.',
        },
      },
      required: ['ref', 'stage'],
    },
    run: (a) => [
      'subject', 'stage', a.ref, a.stage,
      ...(a.conclusion ? ['--conclusion', a.conclusion] : []),
    ],
  },
  {
    name: 'croft_subject_note',
    description:
      'Append to a subject\'s work log. Record findings, dead ends (kind attempt) and ' +
      'decisions as you go — they are what the conclusion is built from.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'e.g. S-12' },
        note: { type: 'string', description: 'Markdown.' },
        kind: { type: 'string', enum: ['note', 'finding', 'decision', 'attempt', 'handoff'] },
      },
      required: ['ref', 'note'],
    },
    run: (a) => ['subject', 'note', a.ref, a.note, ...(a.kind ? ['--kind', a.kind] : [])],
  },
  {
    name: 'croft_subject_todo',
    description:
      'Add a todo (a T-n task) under a subject. For an agent it is claimed at once; ' +
      'work it with the task tools and close it with croft_done. Every todo belongs to a subject.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The subject, e.g. S-12.' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown description.' },
      },
      required: ['ref', 'title'],
    },
    run: (a) => ['subject', 'todo', a.ref, a.title, ...(a.body ? ['--body', a.body] : [])],
  },
  {
    name: 'croft_list',
    description: 'List todos (project T), optionally filtered. For the board, use croft_subject_list.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Todos live in project T.' },
        status: { type: 'string', enum: ['backlog', 'todo', 'doing', 'in-review', 'done', 'cancelled'] },
        type: { type: 'string', enum: ['feature', 'bug', 'improvement', 'chore', 'spike', 'docs'] },
        assignee: {
          type: 'string',
          description: 'Whose tasks: "me" (the human behind this key), an email, a name or a user id.',
        },
      },
      required: ['project'],
    },
    run: (a) => [
      'list', '--project', a.project,
      ...(a.status ? ['--status', a.status] : []),
      ...(a.type ? ['--type', a.type] : []),
      ...(a.assignee ? ['--assignee', a.assignee] : []),
    ],
  },
  {
    name: 'croft_note',
    description:
      'Append to a task\'s work log: what you tried, found, or decided. Record dead ' +
      'ends too — "tried X, no difference" saves the next agent an hour and is as ' +
      'valuable as a fix. Safe to retry; duplicate notes are ignored.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        note: { type: 'string' },
        kind: { type: 'string', enum: ['note', 'finding', 'decision', 'attempt', 'handoff'] },
      },
      required: ['ref', 'note'],
    },
    run: (a) => ['note', a.ref, a.note, ...(a.kind ? ['--kind', a.kind] : [])],
  },
  {
    name: 'croft_log',
    description: 'Read a task\'s work log — what has already been tried.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
    },
    run: (a) => ['log', a.ref],
  },
  {
    name: 'croft_claim',
    description:
      'Claim a task before working it, so agents do not collide. If this reports the ' +
      'task is already held, PICK DIFFERENT WORK rather than forcing it.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
    },
    run: (a) => ['claim', a.ref],
  },
  {
    name: 'croft_checkpoint',
    description:
      'Record where work stopped, so another agent can resume without reading your ' +
      'transcript. Leave one before you stop.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, summary: { type: 'string' } },
      required: ['ref', 'summary'],
    },
    run: (a) => ['checkpoint', a.ref, '--summary', a.summary],
  },
  {
    name: 'croft_release',
    description: 'Drop a claim without closing the task.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
    },
    run: (a) => ['release', a.ref],
  },
  {
    name: 'croft_done',
    description:
      'Close a task. A resolution is REQUIRED: say what was actually done and why. ' +
      'A closed task with no recorded answer is invisible to everyone who comes later.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        resolution: { type: 'string', description: 'What was actually done, and why.' },
        kind: {
          type: 'string',
          enum: ['fixed', 'wont-fix', 'duplicate', 'not-reproducible', 'superseded', 'answered'],
        },
      },
      required: ['ref', 'resolution'],
    },
    run: (a) => ['done', a.ref, '--resolution', a.resolution, ...(a.kind ? ['--kind', a.kind] : [])],
  },
  {
    name: 'croft_deps',
    description:
      'What blocks this task, and what it blocks. Check before claiming — a task ' +
      'with open blockers is not ready to start whatever its status says.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
    },
    run: (a) => ['deps', a.ref],
  },
  {
    name: 'croft_link',
    description:
      'Record that one task must finish before another. Prefer this over writing ' +
      '"waiting on T-40" in a note: a link is visible from both tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        blockedBy: { type: 'string', description: 'The task that must finish first.' },
        remove: { type: 'boolean', description: 'Remove the link instead of adding it.' },
      },
      required: ['ref', 'blockedBy'],
    },
    run: (a) => [a.remove ? 'unblockedby' : 'blockedby', a.ref, a.blockedBy],
  },
  {
    name: 'croft_comment',
    description: 'Leave a comment for the human. Findings for other agents go in the work log.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, text: { type: 'string' } },
      required: ['ref', 'text'],
    },
    run: (a) => ['comment', a.ref, a.text],
  },
]

const server = new Server(
  { name: 'croft', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((t) => t.name === request.params.name)
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool. Available: ${TOOLS.map((t) => t.name).join(', ')}` }],
      isError: true,
    }
  }

  const { text, isError } = await croft(tool.run(request.params.arguments ?? {}))
  return { content: [{ type: 'text', text }], isError }
})

await server.connect(new StdioServerTransport())

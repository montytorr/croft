import { z } from 'zod'
import {
  createNoteSchema,
  createTaskSchema,
  updateTaskSchema,
  NOTE_KINDS,
  RESOLUTION_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
} from '@/schemas/task'
import {
  handoffSchema,
  createStageSchema,
  createSubjectNoteSchema,
  createSubjectSchema,
  subjectMemberSchema,
  createSubjectTodoSchema,
  createLabProjectSchema,
  createTagSchema,
  reorderSchema,
  subjectHumanNoteSchema,
  updateStageSchema,
  updateSubjectSchema,
  updateLabProjectSchema,
  updateTagSchema,
} from '@/schemas/subject'
import { STAGE_CATEGORIES, SUBJECT_NOTE_KINDS } from '@/lib/lab/types'

/**
 * The spec is generated from the same Zod schemas the routes validate with,
 * so it cannot drift. a2a-comms went the other way — a hand-written 1,055-line
 * docs page plus 110KB of prose — and prose is exactly what goes stale.
 */
const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>

const envelope = (dataSchema: Record<string, unknown>) => ({
  type: 'object',
  properties: { success: { const: true }, data: dataSchema },
  required: ['success', 'data'],
})

const errorResponse = {
  description: 'Failure. `code` is machine-readable; enum errors list the valid values.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { const: false },
          error: { type: 'string' },
          code: {
            type: 'string',
            enum: [
              'unauthorized', 'forbidden', 'not_found', 'validation_failed',
              'conflict', 'already_claimed', 'resolution_required',
              'conclusion_required', 'stage_in_use', 'project_in_use', 'handed_off', 'subject_required',
              'secret_detected', 'already_published', 'subject_not_published', 'owner_required',
              'rate_limited', 'internal_error',
            ],
          },
          suggestedResolution: {
            type: 'string',
            description:
              'Present on resolution_required. Drawn from the last checkpoint or most ' +
              'recent finding note, so the caller can confirm rather than invent.',
          },
          problems: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Present when an agent\'s task description is refused as unreadable (CROFT-312): ' +
              'one instruction per problem — a heading to write, a paragraph to break up, a path ' +
              'to put in backticks. `error` repeats them.',
          },
        },
        required: ['success', 'error', 'code'],
      },
    },
  },
}

const refParam = {
  name: 'ref',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Task reference — `CAI-42`, or a raw UUID.',
}

const body = (schema: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema } },
})

const okResponse = (description: string, data: Record<string, unknown> = { type: 'object' }) => ({
  description,
  content: { 'application/json': { schema: envelope(data) } },
})

const stageSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'exploring' },
    color: { type: 'string', example: '#6b7fa6' },
    category: { type: 'string', enum: [...STAGE_CATEGORIES] },
    position: { type: 'integer' },
  },
  required: ['id', 'name', 'color', 'category', 'position'],
}

const tagSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    color: { type: 'string' },
    position: { type: 'integer' },
  },
  required: ['id', 'name', 'color', 'position'],
}

const labProjectSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'Trig' },
    color: { type: 'string', example: '#6b7fa6' },
    handoff_tracker: {
      type: ['string', 'null'],
      example: 'github',
      description: 'The tracker `croft handoff` sends this project\'s todos to. Null with `handoff_target`.',
    },
    handoff_target: {
      type: ['string', 'null'],
      example: 'owner/repo',
      description: 'Where in that tracker: a project key, an `owner/repo`.',
    },
    position: { type: 'integer' },
  },
  required: ['id', 'name', 'color', 'handoff_tracker', 'handoff_target', 'position'],
}

const labProjectListedSchema = {
  ...labProjectSchema,
  properties: {
    ...labProjectSchema.properties,
    subjects: { type: 'integer', description: 'How many subjects, archived ones included, are in it.' },
  },
}

const subjectSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    ref: { type: 'string', example: 'S-12' },
    number: { type: 'integer' },
    title: { type: 'string' },
    body: { type: ['string', 'null'], description: 'The write-up. Absent from list rows.' },
    stage: stageSchema,
    tags: { type: 'array', items: tagSchema },
    project: { oneOf: [labProjectSchema, { type: 'null' }], description: 'The lab project it is part of, if any.' },
    owner: {
      type: ['object', 'null'],
      properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
    },
    conclusion: { type: ['string', 'null'] },
    concluded_at: { type: ['string', 'null'], format: 'date-time', description: 'Absent from list rows.' },
    todos: { type: 'object', properties: { open: { type: 'integer' }, done: { type: 'integer' } } },
    position: { type: 'integer' },
    actor_id: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    archived_at: { type: ['string', 'null'], format: 'date-time' },
    visibility: {
      type: 'string',
      enum: ['private', 'members', 'lab'],
      description: '`lab`: everyone. `members`: the owner and `members`. `private`: the owner.',
    },
    members: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
      description: 'Who the subject is shared with; the owner is not listed. Empty for a lab subject.',
    },
  },
}

const attachmentSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    filename: { type: 'string' },
    mime_type: { type: 'string' },
    size_bytes: { type: 'integer' },
    preview_url: { type: 'string', description: 'Signed, expires within the hour. Renders inline.' },
    download_url: { type: 'string', description: 'Signed, expires within the hour. Forces a save.' },
    content_url: {
      type: 'string',
      description: 'Stable: `/api/v1/attachments/{id}/content`, which redirects a signed-in viewer to a fresh preview. What markdown embeds.',
    },
    kind: {
      type: 'string',
      enum: ['image', 'html', 'pdf', 'video', 'other'],
      description: '`html` is only ever shown in a sandboxed iframe; /api/files serves it under `Content-Security-Policy: sandbox`.',
    },
    uploaded_by: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
}

const humanNoteSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    body: { type: 'string' },
    author: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
}

const multipartFile = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] },
    },
  },
}

const subjectNoteSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    kind: { type: 'string', enum: [...SUBJECT_NOTE_KINDS] },
    note: { type: 'string' },
    actor_type: { type: 'string', enum: ['human', 'agent'] },
    actor_id: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
}

const handoffSchemaObject = {
  type: ['object', 'null'],
  properties: {
    tracker: { type: 'string', example: 'github' },
    ref: { type: 'string', example: 'owner/repo#4' },
    url: { type: ['string', 'null'], format: 'uri' },
    status: { type: ['string', 'null'], description: "The tracker's status at the last sync." },
    synced_at: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['tracker', 'ref', 'url', 'status', 'synced_at'],
}

const subjectTodoSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    ref: { type: 'string', example: 'T-41' },
    number: { type: 'integer' },
    title: { type: 'string' },
    status: { type: 'string', enum: [...TASK_STATUSES] },
    claimed_by: { type: ['string', 'null'] },
    handoff: { ...handoffSchemaObject, description: 'Where the todo was handed off to, or null.' },
    updated_at: { type: 'string', format: 'date-time' },
  },
}


const person = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    name: { type: 'string', description: 'Display name, or the email when there is none.' },
    active: { type: 'boolean', description: 'False once the user is removed or suspended.' },
  },
  required: ['id', 'email', 'name', 'active'],
}

/** One agent key, the same shape to an administrator and to its owner (CROFT-317). */
const agentKey = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    agentName: { type: 'string', example: 'claude-code' },
    name: { type: 'string', example: 'claude-code on cal-mbp', description: 'Paired keys are `<runtime> on <host>`.' },
    keyPrefix: { type: 'string', description: 'The first characters, for recognising a key. Never the key.' },
    createdAt: { type: 'string', format: 'date-time' },
    lastUsedAt: { type: ['string', 'null'], format: 'date-time' },
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
    revoked: {
      type: 'boolean',
      description: 'Refused by the server: revoked, or disabled by an account-wide reset (which leaves `revokedAt` null).',
    },
  },
  required: ['id', 'agentName', 'name', 'keyPrefix', 'createdAt', 'lastUsedAt', 'revokedAt', 'revoked'],
}

const revokedKey = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    agentName: { type: 'string' },
    revokedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'agentName', 'revokedAt'],
}

const createdKey = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    agentName: { type: 'string' },
    name: { type: 'string' },
    keyPrefix: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    key: { type: 'string', description: 'The key itself. Shown in this response only; never recoverable.' },
    warning: { type: 'string' },
  },
  required: ['id', 'agentName', 'name', 'keyPrefix', 'createdAt', 'key', 'warning'],
}

const taskSummary = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    number: { type: 'integer' },
    ref: { type: 'string', example: 'CAI-42' },
    title: { type: 'string' },
    type: { type: 'string', enum: [...TASK_TYPES] },
    status: { type: 'string', enum: [...TASK_STATUSES] },
    priority: { type: 'string', enum: [...TASK_PRIORITIES] },
    labels: { type: 'array', items: { type: 'string' } },
    assignee_user_id: {
      type: 'string',
      format: 'uuid',
      description: 'The human who owns the task. Always set; defaults to the caller\'s user.',
    },
    assignee: { ...person, type: ['object', 'null'] },
    claimed_by: {
      type: ['string', 'null'],
      description: 'The agent executing it right now, if any. Not the owner: that is `assignee`.',
    },
    resolution: { type: ['string', 'null'] },
  },
}

export const openapiSpec = () => ({
  openapi: '3.1.0',
  info: {
    title: 'Croft API',
    version: '0.1.0',
    description: [
      'Agent-first task tracker whose tasks double as shared memory.',
      '',
      '## The contract',
      '',
      '`check → show → act`. Call `GET /search` **before** starting work on a subject:',
      'it returns an index of prior tasks, whether each carries a recorded answer, and',
      'an estimated token cost, so you can open only what matters. Do not re-debug',
      'something already answered.',
      '',
      '## Closing a task',
      '',
      '`done` and `cancelled` are refused without a `resolution`. The rejection includes',
      'a `suggestedResolution` drawn from the last checkpoint, so confirming is usually',
      'enough. A closed task with no recorded answer is invisible to whoever comes next.',
      '',
      '## Claiming',
      '',
      '`POST /tasks/{ref}/claim` is a single conditional update. A 409 means another',
      'agent holds it — pick different work. A lease whose heartbeat has been silent for',
      '15 minutes can be taken over.',
    ].join('\n'),
    license: { name: 'MIT' },
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'One API key per agent (`sk_live_…`). The key\'s agent name and owning user are ' +
          'recorded on every write, which keeps the shared log attributable.',
      },
    },
  },
  paths: {
    '/health': {
      get: {
        summary: 'Liveness probe',
        security: [],
        responses: { '200': okResponse('Service is up.') },
      },
    },
    '/search': {
      get: {
        summary: 'Find prior work — call this first',
        description:
          'Searches tasks, work-log notes and lab subjects at once. Returns an index, never ' +
          'bodies. Hits carrying an answer rank first. ' +
          'Matching is keyword-based (Postgres FTS ANDs terms, widening to OR when the ' +
          'precise pass comes back thin), so a paraphrase can still miss.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          {
            name: 'kinds',
            in: 'query',
            description: 'Comma-separated subset of task,note,subject. Default: all.',
            schema: { type: 'string', example: 'task,subject' },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
        ],
        responses: {
          '200': okResponse('Search index.', {
            type: 'object',
            properties: {
              count: { type: 'integer' },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['task', 'note', 'subject'] },
                    ref: {
                      type: 'string',
                      description: 'A task ref for tasks and notes, `S-n` for subjects.',
                    },
                    title: { type: 'string' },
                    type: { type: 'string' },
                    status: { type: 'string' },
                    resolved: {
                      type: 'boolean',
                      description:
                        'An answer is recorded: a resolution on a task, a finding or decision ' +
                        'on a note, a conclusion on a subject.',
                    },
                    tokens: { type: 'integer', description: 'Rough cost of opening this.' },
                  },
                },
              },
            },
          }),
          '401': errorResponse,
        },
      },
    },
    '/projects/{id}/tasks': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' },
          description: 'Project key or UUID. Only the todo project `T` exists.' },
      ],
      get: {
        summary: 'List tasks in a project',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: [...TASK_STATUSES] } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: [...TASK_TYPES] } },
          { name: 'label', in: 'query', schema: { type: 'string' } },
          { name: 'claimed_by', in: 'query', schema: { type: 'string' } },
          { name: 'mine', in: 'query', schema: { type: 'boolean' },
            description: 'Held by the calling agent (and its session, when it sent one).' },
          { name: 'assignee', in: 'query', schema: { type: 'string' },
            description: 'Owned by: `me`, an email, a display name or a user id.' },
          { name: 'subject', in: 'query', schema: { type: 'string', example: 'S-12' },
            description: 'Todos of this subject. An unknown one is `not_found`.' },
          { name: 'project', in: 'query', schema: { type: 'string' },
            description: 'Todos whose subject is in this lab project (name or id), `none`, or a comma list. An unknown project is `validation_failed`, listing the real ones in `valid`.' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        description:
          'Each row also carries `handoff` (`{tracker, ref, url, status, synced_at}`, or null: the task a todo was ' +
          'handed off to in another tracker), `subject_ref` (`S-12`, or null): the lab pairs todos off this list — and `subject` ' +
          '(`{ref, number, title, project: {name, color} | null}`, or null).',
        responses: { '200': okResponse('Tasks.'), '404': errorResponse },
      },
      post: {
        summary: 'Create a sub-task (a todo belongs to a subject)',
        description:
          'Only a sub-task is filed here, with `parentRef`: it takes its parent\'s subject. Anything else is ' +
          'refused with 422 `subject_required`; file a todo under its subject with `POST /subjects/{ref}/todos`.',
        requestBody: body(json(createTaskSchema)),
        responses: {
          '400': errorResponse,
          '404': errorResponse,
          '422': errorResponse,
        },
      },
    },
    '/tasks/{ref}': {
      parameters: [refParam],
      get: {
        summary: 'Get a task',
        description:
          '`?view=digest` returns a cheap read instead: the resolution in full, findings ' +
          'and decisions from the log, a clipped body, and a count of what was withheld ' +
          'with the token cost of fetching it. Measured against real data, the median body ' +
          'is 2KB and the 90th percentile 5KB, so the body is what a digest has to clip. ' +
          'The digest names the `assignee` and `createdBy`, the actor ' +
          'that filed it.',
        parameters: [
          { name: 'view', in: 'query', schema: { type: 'string', enum: ['full', 'digest'], default: 'full' } },
        ],
        responses: {
          '200': okResponse('Task.', {
            ...taskSummary,
            properties: {
              ...taskSummary.properties,
              subject: {
                type: ['object', 'null'],
                description: 'The lab subject a todo is part of; null for an ordinary task. In the digest only when set.',
                properties: {
                  ref: { type: 'string', example: 'S-12' },
                  number: { type: 'integer' },
                  title: { type: 'string' },
                  project: {
                    type: ['object', 'null'],
                    description:
                      "The subject's lab project. `croft handoff T-n` with no `--to` sends the todo to its `handoff_target` in its `handoff_tracker`.",
                    properties: {
                      name: { type: 'string', example: 'Trig' },
                      handoff_tracker: { type: ['string', 'null'], example: 'github' },
                      handoff_target: { type: ['string', 'null'], example: 'TRIG' },
                    },
                  },
                },
              },
              subject_id: { type: ['string', 'null'], format: 'uuid' },
              handoff: { ...handoffSchemaObject, description: 'The task this todo was handed off to in another tracker, which owns its status. In the digest only when set.' },
            },
          }),
          '404': errorResponse,
        },
      },
      patch: {
        summary: 'Update a task',
        description:
          'Omitted fields are left alone. Moving to `done` or `cancelled` requires ' +
          '`resolution`, otherwise the request is refused with `resolution_required`. ' +
          '`assignee` ' +
          'reassigns it (`me`, an email, a display name or a user id) and is never cleared; ' +
          '`dueDate: null` clears the due date. An agent\'s changed `description` meets the same ' +
          'readable-markdown check as on create. A todo handed off to another tracker keeps its title and body ' +
          'editable, but a change of `status` is refused with 409 `handed_off` until it is taken back ' +
          '(`DELETE /tasks/{ref}/handoff`) or the tracker ends it.',
        requestBody: body(json(updateTaskSchema)),
        responses: {
          '200': okResponse('Updated.', taskSummary),
          '400': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
      delete: {
        summary: 'Delete a task permanently',
        description:
          'For junk that should never have existed. Refused if the task has children, ' +
          'notes or comments from somebody else — cancel it instead, which ' +
          'keeps the record and the reason. Requires `?confirm=<REF>`.',
        parameters: [{ name: 'confirm', in: 'query', required: true, schema: { type: 'string' },
          description: 'The task ref, repeated back.' }],
        responses: {
          '200': okResponse('Deleted.'),
          '400': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/tasks/{ref}/claim': {
      parameters: [refParam],
      post: {
        summary: 'Claim a task',
        description:
          'A 409 means another agent holds it. Pick different work. A todo handed off to another tracker ' +
          'is refused with 409 `handed_off`: its status is that tracker\'s.',
        responses: { '200': okResponse('Claimed.'), '409': errorResponse },
      },
    },
    '/tasks/{ref}/beat': {
      parameters: [refParam],
      post: { summary: 'Heartbeat a claim', responses: { '200': okResponse('Beaten.'), '409': errorResponse } },
    },
    '/tasks/{ref}/checkpoint': {
      parameters: [refParam],
      post: {
        summary: 'Record where work stopped',
        description:
          'Only the latest is kept — it is the payload another agent resumes from. On an unheld todo handed off ' +
          'to another tracker it is refused with 409 `handed_off`, since it would claim the todo.',
        requestBody: body({
          type: 'object',
          properties: { summary: { type: 'string' }, payload: { type: 'object' } },
          required: ['summary'],
        }),
        responses: { '200': okResponse('Saved.'), '404': errorResponse, '409': errorResponse },
      },
    },
    '/tasks/{ref}/release': {
      parameters: [refParam],
      post: {
        summary: 'Drop a claim',
        description: 'Releasing a `doing` todo handed off to another tracker is refused with 409 `handed_off`.',
        responses: { '200': okResponse('Released.'), '409': errorResponse } },
    },
    '/tasks/{ref}/block': {
      parameters: [refParam],
      post: {
        summary: 'Block or unblock',
        description: 'Omit `reason`, or send null, to unblock.',
        requestBody: body({ type: 'object', properties: { reason: { type: ['string', 'null'] } } }),
        responses: { '200': okResponse('Updated.'), '409': errorResponse },
      },
    },
    '/tasks/{ref}/children': {
      parameters: [refParam],
      get: {
        summary: 'Direct sub-tasks, with a closed/total rollup',
        description:
          'Counts closed rather than done: a cancelled sub-task is decided, and a parent ' +
          'reported as permanently incomplete because one piece was dropped is useless.',
        responses: { '200': okResponse('{count, closed, children}.'), '404': errorResponse },
      },
    },
    '/tasks/{ref}/notes/{id}': {
      parameters: [
        refParam,
        { name: 'id', in: 'path', required: true, schema: { type: 'string' },
          description: 'Note id.' },
      ],
      delete: {
        summary: 'Withdraw a note you wrote',
        description:
          'Only the note\'s own author may remove it: a work log is the record of what was ' +
          'tried, and letting one agent erase another\'s would make it untrustworthy. Exists ' +
          'so a note written by mistake can be taken back, and so a scratch task that ' +
          'acquired one is not left permanently undeletable.',
        responses: { '200': okResponse('Withdrawn.'), '403': errorResponse, '404': errorResponse, '409': errorResponse },
      },
    },
    '/tasks/{ref}/notes': {
      parameters: [refParam],
      get: {
        summary: 'Read the work log',
        parameters: [{ name: 'kind', in: 'query', schema: { type: 'string', enum: [...NOTE_KINDS] } }],
        responses: { '200': okResponse('Notes.') },
      },
      post: {
        summary: 'Append to the work log',
        description:
          'Idempotent on content — a retry after a timeout returns `{duplicate:true}` ' +
          'as a success rather than creating a second note. Record dead ends too.',
        requestBody: body(json(createNoteSchema)),
        responses: {
          '201': okResponse('Created.'),
          '200': okResponse('Duplicate; nothing written.'),
          '409': errorResponse,
        },
      },
    },
    '/tasks/{ref}/comments': {
      parameters: [refParam],
      get: { summary: 'List comments', responses: { '200': okResponse('Comments.') } },
      post: {
        summary: 'Add a comment (for the human to read)',
        requestBody: body({
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
        }),
        responses: { '201': okResponse('Created.'), '409': errorResponse },
      },
    },
    '/tasks/{ref}/attachments': {
      parameters: [refParam],
      get: {
        summary: 'List attachments',
        description: 'Each row carries the stored columns and the `Attachment` fields (`kind`, signed `preview_url`/`download_url`, `content_url`).',
        responses: { '200': okResponse('Attachments.', { type: 'array', items: attachmentSchema }) },
      },
      post: {
        summary: 'Upload an attachment',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { file: { type: 'string', format: 'binary' } },
                required: ['file'],
              },
            },
          },
        },
        responses: { '201': okResponse('Uploaded, with signed URLs.'), '400': errorResponse, '409': errorResponse },
      },
    },
    '/attachments/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        summary: 'Get an attachment with fresh signed URLs',
        description: "A task's or a subject's. Delete a subject's file through `/subjects/{ref}/attachments/{id}`.",
        responses: { '200': okResponse('Attachment.', attachmentSchema), '404': errorResponse },
      },
      delete: { summary: "Delete a task's attachment", responses: { '200': okResponse('Deleted.') } },
    },
    '/attachments/{id}/content': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        summary: 'The stable address of a file',
        description:
          'Redirects (302, relative Location) to a freshly signed preview URL. Signed URLs expire within ' +
          'the hour, so markdown embeds this instead: `![shot](/api/v1/attachments/{id}/content)`.',
        responses: { '302': { description: 'To a fresh `/api/files` preview.' }, '401': errorResponse, '404': errorResponse },
      },
    },
    '/events': {
      get: {
        summary: 'Change stream (SSE)',
        description:
          'Server-sent events, for a UI that wants to know when something moved. Polls a ' +
          '`max(updated_at):count` fingerprint every four seconds and lives ten minutes, ' +
          'rather than holding a Realtime subscription open — the stack is shared and a ' +
          'poll that cheap is not worth a websocket.',
        parameters: [{ name: 'project', in: 'query', schema: { type: 'string' } }],
        responses: { '200': okResponse('An event stream.') },
      },
    },
    '/reconcile': {
      post: {
        summary: 'Release abandoned claims',
        description:
          'The backstop for claims that outlive their session. Releases claims held by ' +
          'the calling agent — or, for the `maintenance` key, by anyone in the workspace — ' +
          'that have shown no sign of life — heartbeat, note, checkpoint, edit, or the holder\'s own commit, push, run or status change; the ' +
          'automatic "still held" checkpoint does not count — for `olderThanMinutes` ' +
          '(default 120, deliberately far longer than the ' +
          '15-minute claim lease, because agents barely heartbeat and a release is not as ' +
          'recoverable as a takeover). A `doing` task returns to `todo`; `in-review` keeps ' +
          'its status. Never closes anything: a task with a resolution ' +
          'nobody meant is worse than one plainly still open.',
        requestBody: body({
          type: 'object',
          properties: {
            olderThanMinutes: { type: 'integer', minimum: 5, maximum: 1440, default: 120 },
            dryRun: { type: 'boolean', default: false },
          },
        }),
        responses: { '200': okResponse('What was released.') },
      },
    },
    '/labels': {
      get: {
        summary: 'Every label in use, with a task count',
        responses: { '200': okResponse('Labels, busiest first.') },
      },
      patch: {
        summary: 'Rename, merge or delete a label across every task',
        description:
          'Renaming onto a label that already exists merges the two. `to: null` deletes ' +
          'the label instead. Returns how many tasks changed — a rename that matched ' +
          'nothing otherwise looks identical to one that worked.',
        requestBody: body({
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: ['string', 'null'] },
          },
          required: ['from', 'to'],
        }),
        responses: { '200': okResponse('Applied.'), '400': errorResponse },
      },
    },
    '/branding': {
      get: {
        summary: "The instance's name and accent",
        responses: { '200': okResponse('Branding; a null accent means the stock indigo.') },
      },
      put: {
        summary: 'Set the instance branding (administrator browser session only)',
        requestBody: body({
          type: 'object',
          properties: {
            name: { type: ['string', 'null'], maxLength: 60 },
            accent: { type: ['string', 'null'], pattern: '^#[0-9a-fA-F]{6}$' },
          },
          required: ['name', 'accent'],
        }),
        responses: { '200': okResponse('Saved.'), '400': errorResponse, '403': errorResponse },
      },
    },
    '/subjects': {
      get: {
        summary: 'List subjects on the lab board',
        description:
          'Ordered by stage position, then position within the stage. Archived subjects are ' +
          'left out unless `archived=include` (live and archived) or `archived=only` (`true`/`1` too: archived only).',
        parameters: [
          { name: 'stage', in: 'query', schema: { type: 'string' }, description: 'Stage name (any case) or id.' },
          { name: 'tag', in: 'query', schema: { type: 'string' }, description: 'Tag name or id, or a comma list: subjects carrying any of them.' },
          { name: 'owner', in: 'query', schema: { type: 'string' }, description: '`me`, a user id, an email or a display name.' },
          {
            name: 'project',
            in: 'query',
            schema: { type: 'string' },
            description: 'Lab project name (any case) or id, `none` for subjects in no project, or a comma list: subjects in any of them.',
          },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full text over title, write-up and conclusion.' },
          { name: 'archived', in: 'query', schema: { type: 'string', enum: ['include', 'only', 'true', 'false', '1', '0'] } },
        ],
        responses: { '200': okResponse('SubjectSummary[]', { type: 'array', items: subjectSchema }), '400': errorResponse },
      },
      post: {
        summary: 'File a subject',
        description:
          'Without `stage`, it lands in the first planned stage. `tags` are names of existing tags ' +
          '(unknown ones are refused with the valid list). `project` is a lab project\'s name or id (unknown ones are ' +
          'refused the same way). `owner` defaults to the caller; `null` leaves it unowned. ' +
          'Filing straight into a completed or dropped stage needs a `conclusion` (`conclusion_required`). ' +
          '`visibility` defaults to `lab`; a `private` or `members` subject is filed by its owner (the caller: ' +
          'another owner is `forbidden`, none is `owner_required`), and `members` (`members` visibility only) ' +
          'names who else sees it. A subject the caller cannot see is `not_found` everywhere, exactly as one ' +
          'that does not exist.',
        requestBody: body(json(createSubjectSchema)),
        responses: { '201': okResponse('The subject.', subjectSchema), '400': errorResponse, '404': errorResponse },
      },
    },
    '/subjects/brief': {
      get: {
        summary: 'The lab block of a session briefing',
        parameters: [{ name: 'cwd', in: 'query', schema: { type: 'string' }, description: 'Accepted; not yet used.' }],
        responses: {
          '200': okResponse('Counts per stage name, and up to three active/planned subjects the caller owns.', {
            type: 'object',
            properties: {
              counts: { type: 'object', additionalProperties: { type: 'integer' } },
              mine: { type: 'array', items: subjectSchema },
            },
          }),
        },
      },
    },
    '/subjects/{ref}': {
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } }],
      get: {
        summary: 'Show a subject (`S-12`, `12` or its id)',
        responses: { '200': okResponse('The subject, with its write-up.', subjectSchema), '404': errorResponse },
      },
      patch: {
        summary: 'Edit a subject',
        description:
          'Moving into a completed or dropped stage without a conclusion (already recorded or sent with ' +
          'the move) is refused with `conclusion_required`. Every stage change appends a `stage` note ' +
          '(`to explore → exploring`). `tags` replaces the whole set. `project` is a lab project\'s name or id; ' +
          '`null` takes the subject out of its project. `archived: true` takes it off the board. ' +
          '`visibility` and, on a non-lab subject, `owner` are the owner\'s to change (`forbidden` otherwise, ' +
          'administrators included): `private ↔ members` freely, either → `lab` for good; ' +
          '`lab →` anything else is `already_published`. Each change appends a `visibility` note.',
        requestBody: body(json(updateSubjectSchema)),
        responses: {
          '200': okResponse('The subject.', subjectSchema),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
      delete: {
        summary: 'Delete a subject for good',
        description:
          'Removes the subject with its todos (and their sub-todos), work log, human notes, files, tags and ' +
          'members; tasks handed off from its todos stay in their trackers. The owner may; an administrator only for a ' +
          'subject in the lab (`forbidden` otherwise, checked first). Requires `?confirm=<REF>`; without it the ' +
          'call fails with `validation_failed` and `requiresConfirmation`.',
        parameters: [{ name: 'confirm', in: 'query', schema: { type: 'string', example: 'S-12' } }],
        responses: {
          '200': okResponse('`{deleted: true, ref, id, todosDeleted, attachmentsRemoved}`'),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/subjects/{ref}/members': {
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } }],
      get: {
        summary: 'Who a subject is shared with',
        responses: { '200': okResponse('`{ref, visibility, owner, members}`.'), '404': errorResponse },
      },
      post: {
        summary: 'Share a subject with one more person',
        description:
          'Owner only (`forbidden`). `user` is `me`, an id, an email or a display name. A private subject ' +
          'becomes a `members` one; a lab subject is `already_published` (everyone sees it). Appends a ' +
          '`visibility` note (`shared with Mael`).',
        requestBody: body(json(subjectMemberSchema)),
        responses: {
          '201': okResponse('The subject.', subjectSchema),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/subjects/{ref}/members/{userId}': {
      parameters: [
        { name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } },
        { name: 'userId', in: 'path', required: true, schema: { type: 'string' }, description: 'An id, `me`, an email or a name.' },
      ],
      delete: {
        summary: 'Stop sharing a subject with someone',
        description:
          'The owner removes anybody; a member may remove themselves. File links already issued stay valid ' +
          'for up to an hour.',
        responses: {
          '200': okResponse('The subject, or `{ref, left: true}` when the caller removed themselves.'),
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/subjects/{ref}/publish': {
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } }],
      post: {
        summary: 'Publish a private or members subject to the lab, for good',
        description:
          'Owner only. Everyone sees it and its todos from now on; it cannot be made private again ' +
          '(`already_published`, also the answer for a subject already in the lab). Appends a `visibility` note.',
        responses: {
          '200': okResponse('The subject.', subjectSchema),
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/subjects/{ref}/notes': {
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } }],
      get: {
        summary: "A subject's work log, newest first",
        parameters: [{ name: 'kind', in: 'query', schema: { type: 'string', enum: [...SUBJECT_NOTE_KINDS] } }],
        responses: { '200': okResponse('SubjectNote[]', { type: 'array', items: subjectNoteSchema }), '404': errorResponse },
      },
      post: {
        summary: 'Append to the work log',
        description:
          'Idempotent on (subject, kind + text): a retry answers 200 `{duplicate: true}`. `stage` notes are ' +
          'written by the server and cannot be posted.',
        requestBody: body(json(createSubjectNoteSchema)),
        responses: {
          '201': okResponse('The note.', subjectNoteSchema),
          '200': okResponse('Already recorded: `{duplicate: true}`.'),
          '404': errorResponse,
        },
      },
    },
    '/subjects/{ref}/human-notes': {
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } }],
      get: {
        summary: "People's notes on a subject, newest first",
        responses: { '200': okResponse('SubjectHumanNote[]', { type: 'array', items: humanNoteSchema }), '404': errorResponse },
      },
      post: {
        summary: 'Add a note',
        description:
          'Any member. An agent\'s note is attributed to its human, who may then edit or delete it. Markdown; ' +
          'from an agent a wall of text is refused, and a secret-shaped string always is (`secret_detected`).',
        requestBody: body(json(subjectHumanNoteSchema)),
        responses: { '201': okResponse('The note.', humanNoteSchema), '400': errorResponse, '404': errorResponse },
      },
    },
    '/subjects/{ref}/human-notes/{id}': {
      parameters: [
        { name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } },
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      patch: {
        summary: 'Rewrite a note (its author only)',
        requestBody: body(json(subjectHumanNoteSchema)),
        responses: { '200': okResponse('The note.', humanNoteSchema), '400': errorResponse, '403': errorResponse, '404': errorResponse },
      },
      delete: {
        summary: 'Delete a note (its author, or an administrator)',
        responses: { '200': okResponse('`{deleted: true, id}`.'), '403': errorResponse, '404': errorResponse },
      },
    },
    '/subjects/{ref}/attachments': {
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } }],
      get: {
        summary: "A subject's files, oldest first",
        responses: { '200': okResponse('Attachment[]', { type: 'array', items: attachmentSchema }), '404': errorResponse },
      },
      post: {
        summary: 'Upload a file to a subject',
        description:
          "The same allowlist and size limit as a task's files, HTML included (served only sandboxed). " +
          'An image\'s `content_url` is what the write-up embeds.',
        requestBody: multipartFile,
        responses: { '201': okResponse('The file.', attachmentSchema), '400': errorResponse, '404': errorResponse },
      },
    },
    '/subjects/{ref}/attachments/{id}': {
      parameters: [
        { name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } },
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      delete: {
        summary: "Delete a subject's file",
        responses: { '200': okResponse('`{deleted: true, id}`.'), '404': errorResponse },
      },
    },
    '/subjects/{ref}/todos': {
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'S-12' } }],
      get: {
        summary: "A subject's todos, open ones first",
        responses: { '200': okResponse('SubjectTodo[]', { type: 'array', items: subjectTodoSchema }), '404': errorResponse },
      },
      post: {
        summary: 'Add a todo',
        description:
          'A todo is a task in the system project `T` (created on first use), linked to the subject. ' +
          'Every task verb — claim, note, done — works on its `T-n` ref.',
        requestBody: body(json(createSubjectTodoSchema)),
        responses: { '201': okResponse('The todo.', subjectTodoSchema), '400': errorResponse, '404': errorResponse },
      },
    },
    '/stages': {
      get: {
        summary: 'The board stages, in order',
        responses: { '200': okResponse('Stage[]', { type: 'array', items: stageSchema }) },
      },
      post: {
        summary: 'Add a stage (administrators)',
        requestBody: body(json(createStageSchema)),
        responses: { '201': okResponse('The stage.', stageSchema), '403': errorResponse, '409': errorResponse },
      },
    },
    '/stages/reorder': {
      post: {
        summary: 'Reorder the stages (administrators)',
        description: '`ids` must name every stage exactly once.',
        requestBody: body(json(reorderSchema)),
        responses: { '200': okResponse('Stage[]', { type: 'array', items: stageSchema }), '400': errorResponse, '403': errorResponse },
      },
    },
    '/stages/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      patch: {
        summary: 'Rename, recolour, recategorise or move a stage (administrators)',
        requestBody: body(json(updateStageSchema)),
        responses: { '200': okResponse('The stage.', stageSchema), '403': errorResponse, '404': errorResponse, '409': errorResponse },
      },
      delete: {
        summary: 'Delete a stage (administrators)',
        description: 'Refused with `stage_in_use` (409) while any subject, archived ones included, is in it.',
        responses: { '200': okResponse('Deleted.'), '403': errorResponse, '404': errorResponse, '409': errorResponse },
      },
    },
    '/tags': {
      get: {
        summary: 'The curated tags',
        responses: { '200': okResponse('Tag[]', { type: 'array', items: tagSchema }) },
      },
      post: {
        summary: 'Add a tag (administrators)',
        description: 'Names are stored lower-case and unique.',
        requestBody: body(json(createTagSchema)),
        responses: { '201': okResponse('The tag.', tagSchema), '403': errorResponse, '409': errorResponse },
      },
    },
    '/tags/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      patch: {
        summary: 'Rename, recolour or move a tag (administrators)',
        requestBody: body(json(updateTagSchema)),
        responses: { '200': okResponse('The tag.', tagSchema), '403': errorResponse, '404': errorResponse, '409': errorResponse },
      },
      delete: {
        summary: 'Delete a tag (administrators); it comes off every subject',
        responses: { '200': okResponse('Deleted, with how many subjects carried it.'), '403': errorResponse, '404': errorResponse },
      },
    },
    '/lab-projects': {
      get: {
        summary: 'The lab projects, in order',
        description: 'Each row carries `subjects`: how many subjects, archived ones included, are in it.',
        responses: { '200': okResponse('LabProject[]', { type: 'array', items: labProjectListedSchema }) },
      },
      post: {
        summary: 'Add a lab project (administrators)',
        description:
          'Names are unique in any case. `handoffTracker` and `handoffTarget` say where `croft handoff` sends ' +
          'the project\'s todos (a tracker like `linear` or `github`, and a target in it: a project key, ' +
          'an `owner/repo`): both or neither.',
        requestBody: body(json(createLabProjectSchema)),
        responses: { '201': okResponse('The lab project.', labProjectSchema), '400': errorResponse, '403': errorResponse, '409': errorResponse },
      },
    },
    '/lab-projects/reorder': {
      post: {
        summary: 'Reorder the lab projects (administrators)',
        description: '`ids` must name every lab project exactly once.',
        requestBody: body(json(reorderSchema)),
        responses: {
          '200': okResponse('LabProject[]', { type: 'array', items: labProjectListedSchema }),
          '400': errorResponse,
          '403': errorResponse,
        },
      },
    },
    '/lab-projects/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      patch: {
        summary: 'Rename, recolour, re-key or move a lab project (administrators)',
        description:
          'Null `handoffTracker` and `handoffTarget` clear the hand-off; ' +
          'an omitted field is left as it is.',
        requestBody: body(json(updateLabProjectSchema)),
        responses: {
          '200': okResponse('The lab project.', labProjectSchema),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
      delete: {
        summary: 'Delete a lab project (administrators)',
        description: 'Refused with `project_in_use` (409) while any subject, archived ones included, is in it.',
        responses: { '200': okResponse('Deleted.'), '403': errorResponse, '404': errorResponse, '409': errorResponse },
      },
    },
    '/tasks/{ref}/handoff': {
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'T-41' } }],
      post: {
        summary: 'Record that this todo was handed off to another tracker',
        description:
          'Written by `croft handoff` once the task exists in the tracker, so the link never points at nothing. ' +
          'Re-linking overwrites, and writes a `handoff` note on the subject: `T-41 handed off to <tracker> as ' +
          '<ref>`. From then on the tracker owns the todo\'s status: changing it, claiming it or closing it ' +
          'here is refused with 409 `handed_off`. Also how `croft sync` reports a status it read there: with a ' +
          'done or cancelled `status` it records the once-only `<ref> done: <resolution>` subject note and ' +
          'closes the todo (a resolution kind Croft lacks closes as `verified`): the one path that closes a ' +
          'handed-off todo. A todo whose subject is not `lab` is refused with `subject_not_published` unless ' +
          '`force: true`, because the tracker has no notion of who may see what.',
        requestBody: body(json(handoffSchema)),
        responses: { '200': okResponse('The link.'), '400': errorResponse, '404': errorResponse, '409': errorResponse },
      },
      delete: {
        summary: 'Take a hand-off back',
        description:
          'Clears the link, writes a `handoff` note `T-41 taken back from <tracker> (<ref>)` on the subject, ' +
          'and returns the todo. Nothing is done in the other tracker. 409 `conflict` when the todo is not handed off.',
        responses: { '200': okResponse('The todo.'), '404': errorResponse, '409': errorResponse },
      },
    },
    '/people': {
      get: {
        summary: 'List the people work can be assigned to',
        description: 'Active users only. Open to every authenticated caller, agents included.',
        responses: { '200': okResponse('People.', { type: 'array', items: person }) },
      },
    },
    '/connect': {
      post: {
        summary: 'Start a device pairing (unauthenticated)',
        description:
          'OAuth 2.0 device-authorization-grant shaped: a machine with no credentials yet gets a ' +
          '`deviceCode` to poll with and a `userCode` to show a human, who approves it in a browser ' +
          'at `verificationUrl`. Anyone can call this — it hands out nothing by itself.',
        security: [],
        requestBody: body({
          type: 'object',
          properties: {
            host: {
              type: 'string',
              pattern: '^[A-Za-z0-9._-]{1,100}$',
              description: 'The machine\'s hostname. Shown on the approval card as reported, and in each key\'s name.',
            },
            runtimes: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' },
            },
            cliVersion: { type: 'string', minLength: 1, maxLength: 100 },
          },
          required: ['host', 'runtimes'],
        }),
        responses: {
          '201': okResponse('Pairing started.', {
            type: 'object',
            properties: {
              deviceCode: { type: 'string', description: 'Secret. Only this call and the CLI ever see it.' },
              userCode: { type: 'string', example: 'BCDF-2345' },
              verificationUrl: { type: 'string', format: 'uri' },
              expiresIn: { type: 'integer', example: 600 },
              interval: { type: 'integer', example: 3, description: 'Minimum seconds between polls.' },
            },
            required: ['deviceCode', 'userCode', 'verificationUrl', 'expiresIn', 'interval'],
          }),
          '400': errorResponse,
          '429': errorResponse,
        },
      },
    },
    '/connect/poll': {
      post: {
        summary: 'Poll a device pairing (unauthenticated)',
        description:
          '`approved` is returned exactly once: the request is consumed in the same instant its keys ' +
          'are minted, so a repeated or replayed poll gets `expired` instead of a second copy. An ' +
          'unknown `deviceCode` also reads as `expired` — this never says whether a code ever existed.',
        security: [],
        requestBody: body({
          type: 'object',
          properties: { deviceCode: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
          required: ['deviceCode'],
        }),
        responses: {
          '200': okResponse('Current state of the pairing.', {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['pending', 'denied', 'expired', 'approved'] },
              slowDown: { type: 'boolean', description: 'Polled faster than `interval`. Only ever true alongside `pending`.' },
              user: {
                type: 'object',
                description: 'Present only when `status` is `approved`: the keys\' new owner.',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  email: { type: 'string', format: 'email' },
                  name: { type: 'string' },
                },
                required: ['id', 'email', 'name'],
              },
              keys: {
                type: 'array',
                description: 'Present only when `status` is `approved`. Shown once; never recoverable after this response.',
                items: {
                  type: 'object',
                  properties: { agentName: { type: 'string' }, key: { type: 'string' } },
                  required: ['agentName', 'key'],
                },
              },
            },
            required: ['status'],
          }),
          '400': errorResponse,
        },
      },
    },
    '/connect/{code}/approve': {
      parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string', example: 'BCDF-2345' } }],
      post: {
        summary: 'Approve a pairing request (signed-in human browser session only)',
        description:
          'Mints nothing by itself — keys are minted the moment the CLI\'s next poll redeems the ' +
          'approval, for the approving user only. `runtimes` must be a non-empty subset of what was ' +
          'requested. An agent API key gets 403: this has to be a person, at a keyboard, in a browser. ' +
          'So does a member approving `maintenance`: that key releases anyone\'s claims, so only an ' +
          'administrator can approve it, and the role is checked again when the key is minted.',
        requestBody: body({
          type: 'object',
          properties: {
            runtimes: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' },
            },
          },
          required: ['runtimes'],
        }),
        responses: {
          '200': okResponse('Approved.'),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/connect/{code}/deny': {
      parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string', example: 'BCDF-2345' } }],
      post: {
        summary: 'Deny a pairing request (signed-in human browser session only)',
        responses: {
          '200': okResponse('Denied.'),
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/users': {
      get: {
        summary: 'List users (administrator browser session only)',
        description: 'Each user carries `openTaskCount`: the open tasks they are the assignee of.',
        responses: { '200': okResponse('Users.'), '403': errorResponse },
      },
      post: {
        summary: 'Create a user with an initial password',
        requestBody: body({
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            displayName: { type: 'string', minLength: 1, maxLength: 100 },
            password: { type: 'string', minLength: 12 },
            role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
          },
          required: ['email', 'displayName', 'password'],
        }),
        responses: { '201': okResponse('User created.'), '403': errorResponse, '409': errorResponse },
      },
    },
    '/users/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      patch: {
        summary: 'Edit a user',
        description: 'An administrator cannot change someone else\u2019s `email` (403 `forbidden`): it is where their reset links go.',
        requestBody: body({
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            displayName: { type: 'string', minLength: 1, maxLength: 100 },
            role: { type: 'string', enum: ['admin', 'member'] },
          },
          minProperties: 1,
        }),
        responses: { '200': okResponse('User updated.'), '403': errorResponse, '409': errorResponse },
      },
      delete: {
        summary: 'Disable a user and revoke sessions and active keys',
        description:
          'A user who is the assignee of open tasks (not done or cancelled) is refused with 409 ' +
          '`reason: open_tasks` and `openTaskCount` until `reassignTo` names an active user to take them ' +
          'over; each moved task gets an `assignee_changed` event with `reason: user_deactivated`. ' +
          'On a user already disabled, `reassignTo` hands on any open tasks they still own. ' +
          'This route also reads `reassignTo` from a JSON body `{"reassignTo": "<uuid>"}`.',
        parameters: [
          {
            name: 'reassignTo',
            in: 'query',
            description: 'The active user, other than this one, who becomes the assignee of their open tasks.',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': okResponse('User disabled; `reassignedTaskCount` says how many open tasks moved.'),
          '400': errorResponse,
          '403': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/users/{id}/restore': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { summary: 'Restore a disabled user', responses: { '200': okResponse('User restored.'), '403': errorResponse } },
    },
    '/users/{id}/password': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        summary: 'Set your own password and revoke your browser sessions (refused for anyone else, administrators included)',
        description:
          'An administrator cannot set someone else\u2019s password (403 `forbidden`): send them a reset link with ' +
          '`POST /users/{id}/password-reset` instead.',
        requestBody: body({
          type: 'object',
          properties: { password: { type: 'string', minLength: 12 } },
          required: ['password'],
        }),
        responses: { '200': okResponse('Password set.'), '403': errorResponse },
      },
    },
    '/users/{id}/password-reset': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        summary: 'Email a user a single-use password reset link (administrator browser session only)',
        description:
          'The link goes to the user\u2019s email and works once, for an hour; the administrator never sees it. ' +
          'A new link invalidates any earlier one. Answers `{ sent: true, to }` with the address masked. ' +
          '503 `mail_not_configured` (nothing is created) when RESEND_API_KEY, CROFT_MAIL_FROM or CROFT_BASE_URL ' +
          'is unset; 502 `mail_send_failed` when the mail provider refuses it (the link is invalidated); ' +
          '409 for a disabled user; 429 after five in fifteen minutes for one user.',
        responses: {
          '200': okResponse('Sent.', {
            type: 'object',
            properties: { sent: { type: 'boolean', const: true }, to: { type: 'string' } },
            required: ['sent', 'to'],
          }),
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
          '429': errorResponse,
          '502': errorResponse,
          '503': errorResponse,
        },
      },
    },
    '/users/{id}/keys': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        summary: 'List a user’s agent keys (never the hash)',
        responses: { '200': okResponse('Keys, oldest first.', { type: 'array', items: agentKey }), '403': errorResponse },
      },
      post: {
        summary: 'Create an agent key for yourself (refused for anyone else, administrators included: people pair their own keys)',
        requestBody: body({
          type: 'object',
          properties: {
            agentName: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' },
            name: { type: 'string', minLength: 1, maxLength: 100 },
          },
          required: ['agentName', 'name'],
        }),
        responses: { '201': okResponse('Created; includes the plaintext key.', createdKey), '403': errorResponse, '409': errorResponse },
      },
    },
    '/users/{id}/keys/{keyId}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'keyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      delete: {
        summary: 'Revoke one of a user’s agent keys',
        responses: { '200': okResponse('Key revoked.', revokedKey), '403': errorResponse, '404': errorResponse },
      },
    },
    '/me/keys': {
      get: {
        summary: 'List your own agent keys (signed-in human browser session only)',
        description:
          'Every key you own, active and revoked — the ones `croft setup` paired (named ' +
          '`<runtime> on <host>`) and any an administrator issued you. Never the hash or the key ' +
          'itself: that was shown once, when it was minted. An agent API key gets 403, even an ' +
          'administrator\'s: a key must not be able to list or revoke its siblings.',
        responses: {
          '200': okResponse('Your keys, oldest first.', { type: 'array', items: agentKey }),
          '401': errorResponse,
          '403': errorResponse,
        },
      },
    },
    '/me/keys/{keyId}': {
      parameters: [{ name: 'keyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      delete: {
        summary: 'Revoke one of your own agent keys (signed-in human browser session only)',
        description:
          'The same revocation as `DELETE /users/{id}/keys/{keyId}`: the key is refused on its very ' +
          'next request. A key that is someone else\'s, already revoked, or does not exist is the ' +
          'same 404 — this never says whose a key is. An agent API key gets 403.',
        responses: {
          '200': okResponse('Key revoked.', revokedKey),
          '401': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
        },
      },
    },
  },
  'x-resolution-kinds': [...RESOLUTION_KINDS],
})

import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

/**
 * What the closure finding counts, proved against the database.
 *
 * The predicate is SQL inside a function no migration has ever written out in
 * full — 048 stripped the owner predicates, 050 added actor_type, 051 added
 * the closure CTE, 054 replaced it, each by transforming what was installed
 * before it. A unit test can check the wording of the finding and the shape of
 * the migration; only this can say what the population actually is.
 *
 * CROFT-251 classified all ten tasks the old predicate flagged in a 24h
 * window: none was the bare created->done shape it was filed for, nine had
 * moved to in-review hours earlier, several carried commits and test runs, and
 * some had been closed by a person, who is documented as never claiming. Each
 * of those four shapes is a case below.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const freshDatabase = async () => {
  const name = `croft_closure_${randomUUID().replaceAll('-', '')}`
  const admin = new Client({ connectionString: databaseUrl })
  await admin.connect()
  await admin.query(`create database "${name}"`)
  await admin.end()

  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  const client = new Client({ connectionString: url.toString() })
  await client.connect()
  const files = (await readdir(join(process.cwd(), 'migrations')))
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) {
    await client.query(await readFile(join(process.cwd(), 'migrations', file), 'utf8'))
  }
  return client
}

type Event = { event: string; actorType?: string; data?: Record<string, unknown>; agoHours?: number }

/** One owner, one project, and a closed task per shape being tested. */
const seed = async (client: Client, shapes: Record<string, Event[]>) => {
  const user = randomUUID()
  const project = randomUUID()
  await client.query('insert into app_users (id,email,encrypted_password) values ($1,$2,$3)', [
    user,
    `${user}@test`,
    'x',
  ])
  await client.query(
    `insert into projects (id,owner_user_id,key,title) values ($1,$2,'VIT','Vitals')`,
    [project, user],
  )

  let number = 0
  for (const [title, events] of Object.entries(shapes)) {
    number += 1
    const task = randomUUID()
    await client.query(
      `insert into tasks (id,project_id,number,title,status,type,actor_id,created_at,resolved_at)
       values ($1,$2,$3,$4,'done','chore','seed', now() - interval '6 hours', now() - interval '1 hour')`,
      [task, project, number, title],
    )
    for (const e of events) {
      await client.query(
        `insert into task_activity_events (task_id,actor_type,actor_id,event,data,created_at)
         values ($1,$2,'claude-code · Cal',$3,$4, now() - make_interval(hours => $5::int))`,
        [task, e.actorType ?? 'agent', e.event, JSON.stringify(e.data ?? {}), e.agoHours ?? 2],
      )
    }
  }
  return user
}

/** The close itself: the terminal move and the resolution, as `croft done` writes them. */
const closedBy = (actorType: string): Event[] => [
  { event: 'created', agoHours: 6 },
  { event: 'status_changed', actorType, data: { from: 'backlog', to: 'done' }, agoHours: 1 },
  { event: 'resolved', actorType, data: { kind: 'fixed' }, agoHours: 1 },
]

const vitals = async (client: Client, user: string) => {
  const { rows } = await client.query('select croft_vitals($1, 24) as v', [user])
  return rows[0].v as { tasks: Record<string, number> }
}

describe('croft_vitals closure counting', () => {
  it('counts a task that went from filed to closed with nothing in between', async () => {
    const client = await freshDatabase()
    try {
      const user = await seed(client, { 'bare close': closedBy('agent') })
      const v = await vitals(client, user)
      expect(v.tasks.closed).toBe(1)
      expect(v.tasks.closedWithoutTrace).toBe(1)
      // The key changed with the meaning; a reader must not find the old one
      // and assume it answers the old question.
      expect(v.tasks.closedUnclaimed).toBeUndefined()
    } finally {
      await client.end()
    }
  }, 120_000)

  it('does not count a task the board showed in-review for hours', async () => {
    // Nine of the ten CROFT-251 classified. "Nothing recorded that anyone was
    // working them, so the board showed them free" was false of every one.
    const client = await freshDatabase()
    try {
      const user = await seed(client, {
        'went through review': [
          { event: 'created', agoHours: 6 },
          { event: 'status_changed', data: { from: 'backlog', to: 'in-review' }, agoHours: 4 },
          ...closedBy('agent').slice(1),
        ],
      })
      const v = await vitals(client, user)
      expect(v.tasks.closed).toBe(1)
      expect(v.tasks.closedWithoutTrace).toBe(0)
    } finally {
      await client.end()
    }
  }, 120_000)

  it('does not count a task with delivery evidence against it', async () => {
    const client = await freshDatabase()
    try {
      const user = await seed(client, {
        'has a commit': [
          { event: 'created', agoHours: 6 },
          { event: 'git_commit', data: { sha: 'abc123' }, agoHours: 3 },
          ...closedBy('agent').slice(1),
        ],
        'has a test run': [
          { event: 'created', agoHours: 6 },
          { event: 'run_result', data: { status: 'passed' }, agoHours: 3 },
          ...closedBy('agent').slice(1),
        ],
        'was claimed': [
          { event: 'created', agoHours: 6 },
          { event: 'claimed', data: { agent: 'claude-code · Cal' }, agoHours: 3 },
          ...closedBy('agent').slice(1),
        ],
      })
      const v = await vitals(client, user)
      expect(v.tasks.closed).toBe(3)
      expect(v.tasks.closedWithoutTrace).toBe(0)
    } finally {
      await client.end()
    }
  }, 120_000)

  it('does not count a close made by a person', async () => {
    // claim.ts returns false for a non-agent by design: humans coordinate by
    // talking. Counting their closes measured that design, not a lapse.
    const client = await freshDatabase()
    try {
      const user = await seed(client, {
        'closed by a person': closedBy('human'),
        'closed by a runtime': closedBy('agent'),
      })
      const v = await vitals(client, user)
      expect(v.tasks.closed).toBe(2)
      expect(v.tasks.closedWithoutTrace).toBe(1)
    } finally {
      await client.end()
    }
  }, 120_000)

  it('counts the invisible ones and nothing else, in a mixed window', async () => {
    // Note what the narrowing costs, deliberately: BOTHY-13 from 051's header
    // — created 07:48, git_commit and git_push 07:59, resolved 07:59 — is no
    // longer counted, because something was recorded against it. The question
    // is now "could anyone see this happening", and a commit is a trace even
    // when it lands with the close. Only shapes with no trace at all remain.
    const client = await freshDatabase()
    try {
      const user = await seed(client, {
        'one of five': closedBy('agent'),
        'two of five': closedBy('agent'),
        'three of five': [
          { event: 'created', agoHours: 6 },
          { event: 'status_changed', data: { from: 'backlog', to: 'doing' }, agoHours: 4 },
          ...closedBy('agent').slice(1),
        ],
        'four of five': closedBy('human'),
        'five of five': [
          { event: 'created', agoHours: 6 },
          { event: 'checkpointed', data: { summary: 'halfway' }, agoHours: 3 },
          ...closedBy('agent').slice(1),
        ],
      })
      const v = await vitals(client, user)
      expect(v.tasks.closed).toBe(5)
      expect(v.tasks.closedWithoutTrace).toBe(2)
    } finally {
      await client.end()
    }
  }, 120_000)
})

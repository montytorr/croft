import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '@/lib/db/client'
import { createKnowledge, updateKnowledge } from '@/lib/api/knowledge'
import { recallFor, type Recall } from '@/lib/api/recall'
import type { Actor } from '@/lib/api/auth'

/**
 * `croft recall <ref>` (CROFT-268), on the shape it exists for: a decision
 * closed on one task that constrains another, written as a finding naming it —
 * BB-343 and BB-333. Everything it reads is installed SQL: mentions from
 * triggers, file links from triggers, full-text search.
 */

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const otherProjectId = randomUUID()
const suffix = String(Date.now()).slice(-6)
const KEY = `RC${suffix}`
const OTHER = `RX${suffix}`
const AGENT = 'claude-code · recall@example.test'
const path = `src/recall${suffix}/proxy-ladder.ts`
const word = `zanzibar${suffix}`

const t = {
  target: randomUUID(),
  decider: randomUUID(),
  parent: randomUUID(),
  blocker: randomUUID(),
  unrelated: randomUUID(),
  otherTouched: randomUUID(),
  relatedOther: randomUUID(),
}

const actor = {
  userId: ownerId,
  actorType: 'agent',
  actorId: AGENT,
  userDisplayName: 'Recall',
  role: 'admin',
  rateKey: `recall-${ownerId}`,
  sessionId: null,
} as unknown as Actor

const task = async (
  id: string,
  number: number,
  title: string,
  extra: { status?: string; resolution?: string; parent?: string; project?: string; description?: string } = {},
) =>
  pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status, resolution, parent_id, description)
     values ($1,$2,$3,$4,'agent',$5,$6,$7,$8,$9)`,
    [id, extra.project ?? projectId, number, title, AGENT, extra.status ?? 'todo', extra.resolution ?? null,
      extra.parent ?? null, extra.description ?? null],
  )

const note = (taskId: string, text: string, kind: string) =>
  pool().query(
    `insert into task_notes (task_id, actor_type, actor_id, note, kind) values ($1,'agent',$2,$3,$4)`,
    [taskId, AGENT, text, kind],
  )

const fact = (slug: string, title: string, body: string, extra: Record<string, unknown> = {}) =>
  createKnowledge(actor, { slug, title, body, labels: [], projects: [KEY], entities: [], ...extra })

let recalled: Recall

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password) values ($1,$2,$3)', [
    ownerId,
    `recall-${ownerId}@example.test`,
    'not-used',
  ])
  await pool().query(
    `insert into projects (id, owner_user_id, key, title, task_counter) values
       ($1,$3,$4,'Recall',6), ($2,$3,$5,'Elsewhere',1)`,
    [projectId, otherProjectId, ownerId, KEY, OTHER],
  )

  await task(t.parent, 1, 'Epic: booking reach')
  await task(t.target, 2, `Ship the akamai warm for reach ${word}`, { parent: t.parent })
  await task(t.decider, 3, 'Booker 403 ladder', {
    status: 'done',
    resolution: 'rotate the proxy first, keep the EPS cookie, reset at strike 3',
  })
  await task(t.blocker, 4, 'Token capability flag', { status: 'done', resolution: 'tokens carry a warmed bit now' })
  await task(t.unrelated, 1, `Unrelated ${word} in another project`, { project: otherProjectId })
  await task(t.otherTouched, 2, 'Different project touching the same relative file', { project: otherProjectId })
  await task(t.relatedOther, 3, 'Cross-project related task', {
    project: otherProjectId, description: `This work relates to ${KEY}-2.`,
  })

  await pool().query('insert into task_deps (blocking_id, blocked_id) values ($1, $2)', [t.blocker, t.target])
  await note(t.parent, 'decided: reach work ships behind a flag', 'decision')
  await note(t.decider, 'an unrelated attempt', 'attempt')
  await note(
    t.decider,
    `CONFLICT with ${KEY}-2: this closure does NOT generalise to a warmed token — the cookie is IP-bound there.`,
    'finding',
  )

  await pool().query('insert into file_touches (owner_user_id, path, task_id) values ($1,$2,$3)', [
    ownerId,
    path,
    t.target,
  ])
  await pool().query('insert into file_touches (owner_user_id, path, task_id) values ($1,$2,$3)', [
    ownerId,
    path,
    t.otherTouched,
  ])

  await fact(`recall-about-file-${suffix}`, 'The ladder lives in one file', `see \`${path}\``)
  await fact(`recall-learned-${suffix}`, 'Warmed cookies are IP-bound', 'the _abck cookie', {
    sourceTaskRef: `${KEY}-3`,
  })
  await fact(`recall-related-other-${suffix}`, 'Only true in the other project', 'other-project-only fact', {
    sourceTaskRef: `${OTHER}-3`, projects: [OTHER],
  })
  await fact(`recall-related-global-${suffix}`, 'True everywhere', 'a globally scoped fact', {
    sourceTaskRef: `${OTHER}-3`, projects: [],
  })
  await fact(`recall-terms-${suffix}`, `Reach and ${word}`, `${word} akamai warm reach notes`)
  await fact(`recall-other-file-${suffix}`, 'A fact scoped to another project', `see \`${path}\``, {
    projects: [OTHER],
  })
  await fact(`recall-withdrawn-${suffix}`, 'Old ladder note', `see \`${path}\``)
  await updateKnowledge(actor, `recall-withdrawn-${suffix}`, { supersededBy: `recall-about-file-${suffix}` })
  await createKnowledge(actor, {
    slug: `recall-elsewhere-${suffix}`,
    title: `Elsewhere ${word} akamai warm reach`,
    body: `${word} akamai warm reach`,
    labels: [],
    projects: [OTHER],
    entities: [],
  })

  recalled = await recallFor(ownerId, {
    id: t.target,
    ref: `${KEY}-2`,
    title: `Ship the akamai warm for reach ${word}`,
    description: null,
    project_key: KEY,
    project_id: projectId,
  })
})

afterAll(async () => {
  await pool().query('delete from knowledge where slug like $1', [`recall-%-${suffix}`])
  await pool().query('delete from projects where id = any($1)', [[projectId, otherProjectId]])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('recallFor', () => {
  it('leads with the finding that names this task, excerpted around the name', () => {
    const [first] = recalled.decisions
    expect(first).toMatchObject({ ref: `${KEY}-3`, kind: 'finding' })
    expect(first?.why).toContain('names this task')
    expect(first?.text).toContain(`CONFLICT with ${KEY}-2`)
  })

  it('carries the resolution it conflicts with, the parent decision and the blocker', () => {
    const lines = recalled.decisions.map((d) => [d.ref, d.kind, d.why.join(',')].join(' '))
    expect(lines).toContain(`${KEY}-3 resolution mentions this task`)
    expect(lines).toContain(`${KEY}-1 decision parent`)
    expect(lines).toContain(`${KEY}-4 resolution blocks this`)
  })

  it('never offers attempts, or the task itself', () => {
    expect(recalled.decisions.map((d) => d.text)).not.toContain('an unrelated attempt')
    expect(recalled.decisions.map((d) => d.ref)).not.toContain(`${KEY}-2`)
  })

  it('finds knowledge by the file the task touched and by where it was learned', () => {
    const bySlug = new Map(recalled.knowledge.map((k) => [k.slug, k.why]))
    expect(bySlug.get(`recall-about-file-${suffix}`)).toContain(`about ${path}`)
    expect(bySlug.get(`recall-learned-${suffix}`)).toContain(`learned on ${KEY}-3`)
  })

  it('does not recall another project’s knowledge through a shared relative file path', () => {
    expect(recalled.knowledge.map((k) => k.slug)).not.toContain(`recall-other-file-${suffix}`)
  })

  it('does not recall another project’s knowledge through a related source task', async () => {
    // Without the mention this passes vacuously: the task would not be related
    // at all, and nothing about scope would have been tested.
    const { rows } = await pool().query(
      'select 1 from task_mentions where source_task_id = $1 and target_task_id = $2',
      [t.relatedOther, t.target],
    )
    expect(rows).toHaveLength(1)
    expect(recalled.knowledge.map((k) => k.slug)).not.toContain(`recall-related-other-${suffix}`)
  })

  it('does recall globally scoped knowledge learned on that same related task', () => {
    const bySlug = new Map(recalled.knowledge.map((k) => [k.slug, k.why]))
    expect(bySlug.get(`recall-related-global-${suffix}`)).toContain(`learned on ${OTHER}-3`)
  })

  it('matches terms within the task\'s project only, and ranks links above matches', () => {
    const slugs = recalled.knowledge.map((k) => k.slug)
    expect(slugs).toContain(`recall-terms-${suffix}`)
    expect(slugs).not.toContain(`recall-elsewhere-${suffix}`)
    expect(slugs.indexOf(`recall-terms-${suffix}`)).toBeGreaterThan(slugs.indexOf(`recall-about-file-${suffix}`))
  })

  it('leaves out superseded knowledge', () => {
    expect(recalled.knowledge.map((k) => k.slug)).not.toContain(`recall-withdrawn-${suffix}`)
  })
})

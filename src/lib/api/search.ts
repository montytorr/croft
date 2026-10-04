import { admin, pool } from '@/lib/db/client'
import { subjectByRefQuery } from './subjects'

/**
 * Query construction for prior-work discovery.
 *
 * Postgres full-text search ANDs the terms of a websearch query, which is the
 * right default for precision: an agent searching "supavisor pool timeouts"
 * wants the task about exactly that. It is the wrong behaviour when the agent
 * words the subject differently from whoever filed it, which is most of the
 * time — and a zero-result search reads as "this is new", the single most
 * expensive wrong answer this system can give.
 *
 * That was answered for years by trying the precise query first and widening
 * only when it came back thin. CROFT-247 measured what it cost in `search_all`: an AND over every content
 * word of a 9-13 word question matched the expected row 3 times in 22 live
 * searches, and the rows it DID match — long descriptions that happen to
 * contain every word somewhere — were enough to switch the widened arm off.
 * Three irrelevant rows suppressed the arm that answers the question.
 *
 * So, since migration 055: both arms always run and are merged. The precise
 * arm is no longer "every word of the sentence" but at least half of
 * `distinctiveTerms()`, counted per row, which is a superset of what it used
 * to match; the wide arm is the same OR it always was; and a row found by both
 * appears once, in the precise head.
 */

/** Words too common to be worth ORing on; they would match half the corpus. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'what',
  'why', 'how', 'are', 'was', 'were', 'not', '但', 'les', 'des', 'une', 'dans',
  'pour', 'avec', 'sur', 'est', 'sont', 'pas', 'que', 'qui',
])

export const distinctiveTerms = (query: string): string[] =>
  [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    ),
  ].slice(0, 8)

/**
 * The distinctive terms, passed to the database as an array.
 *
 * The database needs the terms individually, not pre-joined: it ranks widened
 * results by how many DISTINCT terms a row matches, which cannot be recovered
 * from an already-ORed string.
 */
export const widenedTerms = (query: string): string[] | null => {
  const terms = distinctiveTerms(query)
  return terms.length >= 2 ? terms : null
}

/**
 * A ref is an exact address, not a phrase to match.
 *
 * Searching `CROFT-131` returned CROFT-105 — the task whose resolution
 * mentions it — and never 131 itself; searching `CROFT-106` returned nothing at
 * all. The ref is a project key plus a number, and the key lives in another
 * table, so no generated column on `tasks` can reach it and the vector has
 * never contained it.
 *
 * That matters more here than it looks. A ref is designed to escape into
 * commits, notes and transcripts precisely so it can be pasted back, and
 * `croft check` is the verb every agent is told to run first. Pasting one in
 * got you everything that mentions it and never the thing you asked for.
 *
 * So a ref-shaped query is resolved directly and put first, and the full-text
 * pass still runs underneath it — what references this task is a genuinely
 * useful second answer, just not the only one.
 */
const REF_QUERY = /^\s*([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,6})\s*$/

/**
 * A bare number is an address too.
 *
 * Typing `131` while looking at a project is how a person refers to a task —
 * the key is the thing they already know and do not repeat. It returned twenty
 * rows of prose that happen to contain those digits, and not the task.
 *
 * Without a project it is genuinely ambiguous: CROFT-131, OD-131 and HM-131 can
 * all exist. All of them are returned rather than one being guessed at, each
 * carrying its own ref, and capped — someone searching `404` or `500` wants the
 * error, and a handful of same-numbered tasks ahead of it is a nudge where
 * twenty would be an obstruction.
 */
const NUMBER_QUERY = /^\s*(\d{1,6})\s*$/

/**
 * The same columns a ranked row carries. A row assembled here renders in the
 * same list, so a stubbed priority or a missing claim would read as fact.
 */
const EXACT_COLUMNS =
  'id, number, title, description, type, status, priority, resolution, ' +
  'resolution_kind, claimed_by, external_ref, updated_at, ' +
  'project:projects!project_id!inner(key, owner_user_id)'
const BARE_NUMBER_LIMIT = 5

type ExactTask = {
  id: string
  number: number
  title: string
  description: string | null
  type: string
  status: string
  priority: string
  resolution: string | null
  resolution_kind: string | null
  claimed_by: string | null
  external_ref: string | null
  updated_at: string
  project: { key: string } | { key: string }[] | null
}

/**
 * The exact-address paths read tasks directly rather than through the ranked
 * RPCs, so they apply the same rule themselves: a todo whose subject the viewer
 * cannot see is not found, exactly as if it did not exist.
 */
const visibleTaskFilter = async (viewerId: string): Promise<string> => {
  const { rows } = await pool().query<{ id: string }>(
    'select croft_visible_subjects($1) as id',
    [viewerId],
  )
  return rows.length > 0
    ? `subject_id.is.null,subject_id.in.(${rows.map((row) => row.id).join(',')})`
    : 'subject_id.is.null'
}

const keyOfProject = (project: ExactTask['project']) =>
  (Array.isArray(project) ? project[0]?.key : project?.key) ?? null

/** Tasks that carry a bare number as their number, newest first, capped. */
const tasksByNumber = async (viewerId: string, q: string): Promise<ExactTask[]> => {
  const match = NUMBER_QUERY.exec(q)
  if (!match?.[1]) return []

  const { data } = await admin()
    .from('tasks')
    .select(EXACT_COLUMNS)
    .eq('number', Number(match[1]))
    .or(await visibleTaskFilter(viewerId))
    .order('updated_at', { ascending: false })
    .limit(BARE_NUMBER_LIMIT)
  return (data ?? []) as unknown as ExactTask[]
}

const taskByRef = async (viewerId: string, q: string): Promise<ExactTask | null> => {
  const match = REF_QUERY.exec(q)
  if (!match?.[1] || !match[2]) return null

  const { data } = await admin()
    .from('tasks')
    .select(EXACT_COLUMNS)
    .eq('projects.key', match[1].toUpperCase())
    .eq('number', Number(match[2]))
    .or(await visibleTaskFilter(viewerId))
    .maybeSingle()

  return (data as unknown as ExactTask | null) ?? null
}

const asSearchAllRow = (task: ExactTask): SearchAllRow => ({
  kind: 'task',
  id: task.id,
  ref: `${keyOfProject(task.project)}-${task.number}`,
  title: task.title,
  subtitle: task.description?.slice(0, 200) ?? null,
  project_key: keyOfProject(task.project),
  status: task.status,
  type: task.type,
  answered: Boolean(task.resolution),
  updated_at: task.updated_at,
  body_bytes: (task.description?.length ?? 0) + (task.resolution?.length ?? 0),
  // Above every ranked hit on purpose: an exact address outranks a mention.
  rank: Number.POSITIVE_INFINITY,
  widened: false,
})

/**
 * The unified index: tasks, work-log notes and subjects. What `croft check`
 * calls, because the agent asking "has this been done or debugged" does not
 * care which table the answer happens to live in.
 */
export type SearchAllRow = {
  kind: 'task' | 'note' | 'subject'
  id: string
  ref: string
  title: string
  subtitle: string | null
  project_key: string | null
  status: string | null
  type: string | null
  answered: boolean
  updated_at: string
  body_bytes: number
  rank: number
  widened: boolean
}

export const searchAll = async (
  userId: string,
  q: string,
  filters: { kinds?: string[] },
  limit: number,
): Promise<{ rows: SearchAllRow[]; widened: boolean }> => {
  const { data, error } = await admin().rpc('search_all', {
    p_owner: userId,
    p_query: q,
    p_terms: widenedTerms(q),
    p_project: null,
    p_kinds: filters.kinds && filters.kinds.length > 0 ? filters.kinds : null,
    p_limit: limit,
  })

  if (error) throw new Error(error.message)

  const rows = (data ?? []) as SearchAllRow[]

  // The task an address names, first, and never twice: the full-text pass can
  // also find it legitimately, by title.
  const wantsTasks = !filters.kinds || filters.kinds.includes('task')
  const addressed = wantsTasks
    ? await (async () => {
        const byRef = await taskByRef(userId, q)
        return byRef ? [byRef] : await tasksByNumber(userId, q)
      })()
    : []

  // `S-12` names a subject the same way `CAI-42` names a task.
  const wantsSubjects = (!filters.kinds || filters.kinds.includes('subject'))
  const subject = wantsSubjects ? await subjectByRefQuery(q, userId) : null
  const exactSubject: SearchAllRow[] = subject
    ? [{
        kind: 'subject',
        id: subject.id,
        ref: subject.ref,
        title: subject.title,
        subtitle: subject.conclusion ? subject.conclusion.replace(/\s+/g, ' ').slice(0, 120) : null,
        project_key: null,
        status: subject.stage.name,
        type: 'subject',
        answered: Boolean(subject.conclusion),
        updated_at: subject.updated_at,
        body_bytes: (subject.body?.length ?? 0) + (subject.conclusion?.length ?? 0),
        rank: 1,
        widened: false,
      }]
    : []

  const addressedIds = new Set(addressed.map((t) => t.id))
  const withExact =
    addressed.length > 0 || exactSubject.length > 0
      ? [
          ...exactSubject,
          ...addressed.map(asSearchAllRow),
          ...rows.filter(
            (r) => !(r.kind === 'task' && addressedIds.has(r.id)) && !(r.kind === 'subject' && r.id === subject?.id),
          ),
        ]
      : rows

  /**
   * Widened describes the full-text pass. An exact hit is not a loose match and
   * must not make the caller think the rest were precise — so it is read off
   * `rows`, never off the addressed head.
   *
   * "Any row was loose" stopped meaning anything the moment 055 made both arms
   * run: nearly every search returns some loose row, and a flag that is almost
   * always true would have turned `croft check`'s "treat this subject as new"
   * warning into noise printed over correct answers.
   *
   * What the flag is for is unchanged, so it is derived from the thing that
   * still carries that meaning: NOTHING cleared the precise arm. Zero rows is
   * not widening, it is `zeroResults`, which 024 counts separately.
   */
  const anyPrecise = rows.some((r) => !r.widened)
  return { rows: withExact.slice(0, limit), widened: rows.length > 0 && !anyPrecise }
}

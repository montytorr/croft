import Link from 'next/link'
import { FileText, FlaskConical, ListTodo } from 'lucide-react'
import { ProjectIcon } from '@/components/icons'
import { cn } from '@/lib/utils'
import type { SearchAllRow } from '@/lib/api/search'
import { Highlight, queryTerms } from './highlight'

/**
 * Results across subjects, todos and their notes.
 *
 * The task-only list next door stays as it is because it carries selection and
 * bulk edit, which only mean anything for todos. This renders the rest in rank
 * order without pretending a subject can be bulk-assigned a priority.
 */

type KindMeta = { label: string; Icon: typeof ListTodo; tone: string; color: string }

// Keyed by string, so a kind the search stops or starts returning renders as
// something rather than breaking the page.
const KIND_META: Record<string, KindMeta> = {
  subject: { label: 'Subject', Icon: FlaskConical, tone: 'text-stage-active', color: 'var(--stage-active)' },
  task: { label: 'Todo', Icon: ListTodo, tone: 'text-status-in-review', color: 'var(--status-in-review)' },
  note: { label: 'Note', Icon: FileText, tone: 'text-fg-muted', color: 'var(--fg-muted)' },
}
const metaOf = (kind: string): KindMeta =>
  KIND_META[kind] ?? { label: kind, Icon: FileText, tone: 'text-fg-subtle', color: 'var(--fg-subtle)' }

/** The kind of a hit, as a small pill in its own colour. */
const KindBadge = ({ kind }: { kind: string }) => {
  const { label, color } = metaOf(kind)
  return (
    <span
      className="inline-flex h-[1rem] shrink-0 items-center rounded-full border px-1.5 text-[0.625rem] font-medium tracking-[0.04em] uppercase"
      style={{
        color,
        backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
        borderColor: `color-mix(in oklab, ${color} 28%, transparent)`,
      }}
    >
      {label}
    </span>
  )
}

/**
 * Where a hit leads. A subject opens its page; a note lives on its todo, so it
 * opens the todo — the note ref IS the task ref.
 */
const hrefFor = (row: SearchAllRow): string | null => {
  const kind: string = row.kind
  const subject = /^S-(\d+)$/.exec(row.ref)
  if (kind === 'subject' || subject) return subject ? `/subjects/${subject[1]}` : null
  if (kind === 'task' || kind === 'note') {
    const [key, number] = row.ref.split('-')
    return key && number ? `/projects/${key}/tasks/${number}` : null
  }
  return null
}

const Row = ({ row, terms }: { row: SearchAllRow; terms: string[] }) => {
  const { Icon, tone } = metaOf(row.kind)
  const href = hrefFor(row)

  const body = (
    // A bounded measure inside a full-width row: the hover and the rule
    // still span the page, but the title and its cost stay within one glance
    // instead of sitting a screen apart on a wide monitor.
    <div className="flex max-w-4xl min-w-0 items-start gap-2.5">
      <Icon size={13} className={cn('mt-[0.1875rem] shrink-0', tone)} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-fg-subtle shrink-0 font-mono text-[0.6875rem]">{row.ref}</span>
          {row.project_key && (
            <span className="flex shrink-0 items-center gap-1">
              <ProjectIcon size={11} projectKey={row.project_key} />
            </span>
          )}
          <KindBadge kind={row.kind} />
          {row.answered && (
            <span className="text-status-done text-[0.6875rem]">
              {(row.kind as string) === 'subject' ? 'concluded' : 'answered'}
            </span>
          )}
          {row.status === 'superseded' && (
            <span className="text-danger text-[0.6875rem]">superseded</span>
          )}
        </div>

        <p className="text-fg mt-1 text-[0.8125rem] leading-snug">
          <Highlight text={row.title} terms={terms} />
        </p>

        {row.subtitle && (
          <p className="text-fg-subtle mt-0.5 truncate text-[0.6875rem]">
            <Highlight text={row.subtitle} terms={terms} />
          </p>
        )}
      </div>

      {/* What opening it costs, in the same units `croft check` prints. A
          bare "~19" read as a minus sign and a mystery number. */}
      {row.body_bytes > 0 && (
        <span
          className="text-fg-subtle shrink-0 self-center text-[0.6875rem] tabular-nums"
          title="Roughly how many tokens it takes to read this in full"
        >
          ~{Math.ceil(row.body_bytes / 4)} tok
        </span>
      )}
    </div>
  )

  const className = 'border-border/70 block border-b px-4 py-2.5 last:border-0'

  return href ? (
    <Link href={href} className={cn(className, 'row-hover')}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

/**
 * Grouped by kind, in rank order within each group, and the groups in the
 * order of their best hit — so the top result is still the first thing on the
 * page, and a question answered by a fact is not buried under ten tasks that
 * merely mention it.
 */
export const UnifiedResults = ({ rows, query = '' }: { rows: SearchAllRow[]; query?: string }) => {
  const terms = queryTerms(query)
  // Rank order, not grouped by kind: the ranking already puts the best answer
  // first whatever it is, and grouping would bury a fact under ten tasks. The
  // badge on each row says what it is.
  return (
    <div className="stagger">
      {rows.map((row) => (
        <Row key={`${row.kind}:${row.id}`} row={row} terms={terms} />
      ))}
    </div>
  )
}

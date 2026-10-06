import { ArrowUpRight } from 'lucide-react'
import type { Handoff } from '@/lib/lab/types'
import { cn } from '@/lib/utils'

/**
 * Where a handed-off todo's work is being done: `↗ REF · doing`. The status is
 * as of the last sync, so it stays grey rather than borrowing a status colour
 * it may no longer have. With a URL the badge opens the task in its tracker.
 */
export const HandoffBadge = ({ handoff, className }: { handoff: Handoff | null | undefined; className?: string }) => {
  if (!handoff) return null
  const classes = cn(
    'border-border text-fg-muted inline-flex h-[1.125rem] shrink-0 items-center gap-1 rounded border px-1.5 font-mono text-aux',
    handoff.url && 'hover:border-border-strong hover:text-fg transition-colors',
    className,
  )
  const title = `Handed off to ${handoff.tracker}: its status moves there`
  const body = (
    <>
      <ArrowUpRight size={10} aria-hidden />
      {handoff.ref}
      {handoff.status ? <span className="text-fg-subtle">· {handoff.status}</span> : null}
    </>
  )
  return handoff.url ? (
    <a
      href={handoff.url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={classes}
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </a>
  ) : (
    <span title={title} className={classes}>
      {body}
    </span>
  )
}

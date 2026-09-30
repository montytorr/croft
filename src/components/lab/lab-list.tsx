'use client'

import Link from 'next/link'
import { Avatar } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import type { Stage, SubjectSummary } from '@/lib/lab/types'
import { CATEGORY_LABEL, StageGlyph, stageTone } from './stage'
import { TagChip } from './tag-chip'

const Counts = ({ todos }: { todos: SubjectSummary['todos'] }) =>
  todos.open + todos.done === 0 ? (
    <span className="text-fg-subtle/70 text-[0.6875rem]">no todos</span>
  ) : (
    <span className="text-fg-subtle text-[0.6875rem] tabular-nums" title={`${todos.open} open, ${todos.done} done`}>
      <span className="text-fg-muted font-medium">{todos.open}</span> open
      <span className="mx-1 opacity-50">·</span>
      {todos.done} done
    </span>
  )

const Row = ({ subject }: { subject: SubjectSummary }) => (
  <li>
    <Link
      href={`/subjects/${subject.number}`}
      className="row-hover group flex min-h-[3rem] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 md:flex-nowrap md:px-6"
    >
      <span className="text-fg-subtle w-[3rem] shrink-0 font-mono text-[0.6875rem] tabular-nums">{subject.ref}</span>
      <span className="min-w-0 flex-1">
        <span className="text-fg block truncate text-[0.875rem] font-medium">{subject.title}</span>
        {subject.conclusion ? (
          <span className="writeup-sm text-fg-muted block truncate !text-[0.8125rem] italic">{subject.conclusion}</span>
        ) : null}
      </span>
      {subject.tags.length > 0 ? (
        <span className="hidden max-w-[16rem] shrink items-center gap-1 overflow-hidden lg:flex">
          {subject.tags.slice(0, 3).map((tag) => (
            <TagChip key={tag.id} tag={tag} />
          ))}
        </span>
      ) : null}
      <span className="w-[6.5rem] shrink-0 text-right">
        <Counts todos={subject.todos} />
      </span>
      <span className="flex w-[7.5rem] shrink-0 items-center gap-1.5" title={subject.owner ? `Owner: ${subject.owner.name}` : 'No owner'}>
        {subject.owner ? (
          <>
            <Avatar name={subject.owner.name} size={18} />
            <span className="text-fg-muted truncate text-[0.75rem]">{subject.owner.name}</span>
          </>
        ) : (
          <span className="text-fg-subtle/70 text-[0.75rem]">unowned</span>
        )}
      </span>
      <RelativeTime iso={subject.updated_at} className="text-fg-subtle hidden w-[4.5rem] shrink-0 text-right text-[0.6875rem] sm:block" />
    </Link>
  </li>
)

/**
 * The lab as a notebook: one section per stage, in pipeline order, each with
 * its subjects beneath. Empty stages still show, as a line, so the list reads
 * as the whole pipeline and not only the parts that are busy.
 */
export const LabList = ({ subjects, stages }: { subjects: SubjectSummary[]; stages: Stage[] }) => (
  <div className="pb-16">
    {stages.map((stage) => {
      const here = subjects.filter((s) => s.stage.id === stage.id)
      return (
        <section key={stage.id} aria-label={stage.name}>
          <h2
            className="rig-band border-border sticky top-0 z-10 flex h-10 items-center gap-2.5 border-y px-4 md:px-6"
            style={{ boxShadow: `inset 3px 0 0 ${stageTone(stage)}` }}
          >
            <StageGlyph stage={stage} size={14} />
            <span className="text-fg text-[0.8125rem] font-medium">{stage.name}</span>
            <span className="text-fg-subtle text-[0.6875rem] tabular-nums">{here.length}</span>
            <span className="text-fg-subtle ml-auto text-[0.65625rem] tracking-[0.06em] uppercase">
              {CATEGORY_LABEL[stage.category]}
            </span>
          </h2>
          {here.length === 0 ? (
            <p className="text-fg-subtle/80 px-4 py-2.5 text-[0.75rem] italic md:px-6">Nothing at this stage.</p>
          ) : (
            <ul className="divide-border/70 stagger divide-y">
              {here.map((subject) => (
                <Row key={subject.id} subject={subject} />
              ))}
            </ul>
          )}
        </section>
      )
    })}
  </div>
)

'use client'

import Link from 'next/link'
import { Avatar } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import type { Stage, SubjectSummary } from '@/lib/lab/types'
import { CATEGORY_LABEL, StageGlyph, stageTone } from './stage'
import { ProjectLabel } from './project-label'
import { TagChip } from './tag-chip'
import { LockMark } from './visibility'

const Counts = ({ todos }: { todos: SubjectSummary['todos'] }) =>
  todos.open + todos.done === 0 ? (
    <span className="text-fg-subtle text-aux">no todos</span>
  ) : (
    <span className="text-fg-subtle text-aux tabular-nums" title={`${todos.open} open, ${todos.done} done`}>
      <span className="text-fg-muted font-medium">{todos.open}</span> open
      <span className="mx-1 opacity-50">·</span>
      {todos.done} done
    </span>
  )

const Row = ({ subject }: { subject: SubjectSummary }) => (
  <li>
    <Link
      href={`/subjects/${subject.number}`}
      className="row-hover group flex flex-col gap-1.5 px-4 py-3 lg:min-h-[3.5rem] lg:flex-row lg:items-center lg:gap-x-3 lg:px-6 lg:py-2"
    >
      <span className="text-fg-subtle hidden w-[3rem] shrink-0 font-mono text-aux tabular-nums lg:block">{subject.ref}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-start gap-1.5 lg:items-center">
          <LockMark visibility={subject.visibility} members={subject.members.length} />
          <span className="text-fg line-clamp-2 text-ui font-medium text-pretty lg:line-clamp-1">{subject.title}</span>
        </span>
        {subject.conclusion ? (
          <span className="writeup-sm text-fg-muted mt-0.5 line-clamp-2 block lg:line-clamp-1 !text-ui">{subject.conclusion}</span>
        ) : null}
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:contents">
        <span className="text-fg-subtle font-mono text-aux tabular-nums lg:hidden">{subject.ref}</span>
        {subject.project ? (
          <span className="flex max-w-[9rem] shrink-0 items-center" title={`Project: ${subject.project.name}`}>
            <ProjectLabel project={subject.project} />
          </span>
        ) : null}
        {subject.tags.length > 0 ? (
          <span className="hidden max-w-[16rem] shrink items-center gap-1 overflow-hidden xl:flex">
            {subject.tags.slice(0, 3).map((tag) => (
              <TagChip key={tag.id} tag={tag} />
            ))}
          </span>
        ) : null}
        <span className="shrink-0 lg:w-[7.5rem] lg:text-right">
          <Counts todos={subject.todos} />
        </span>
        <span className="flex shrink-0 items-center gap-1.5 lg:w-[7.5rem]" title={subject.owner ? `Owner: ${subject.owner.name}` : 'No owner'}>
          {subject.owner ? (
            <>
              <Avatar name={subject.owner.name} size={20} />
              <span className="text-fg-muted truncate text-aux">{subject.owner.name}</span>
            </>
          ) : (
            <span className="text-fg-subtle text-aux">unowned</span>
          )}
        </span>
        <RelativeTime iso={subject.updated_at} className="text-fg-subtle shrink-0 text-aux lg:w-[5rem] lg:text-right" />
      </span>
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
            <span className="text-fg text-ui font-medium">{stage.name}</span>
            <span className="text-fg-subtle text-aux tabular-nums">{here.length}</span>
            <span className="text-fg-subtle ml-auto text-micro tracking-[0.06em] uppercase">
              {CATEGORY_LABEL[stage.category]}
            </span>
          </h2>
          {here.length === 0 ? (
            <p className="text-fg-subtle px-4 py-2.5 text-aux md:px-6">Nothing at this stage.</p>
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

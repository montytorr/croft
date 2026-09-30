import type { Metadata } from 'next'
import { cache } from 'react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser } from '@/lib/data'
import {
  getCairnConnection,
  getSubject,
  listLabProjects,
  listStages,
  listSubjectAttachments,
  listSubjectHumanNotes,
  listLabTodos,
  listSubjectNotes,
  listTags,
} from '@/lib/lab/data'
import { parseSubjectRef } from '@/lib/lab/types'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { LiveUpdates } from '@/components/live-updates'
import { Avatar } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import { StageBadge } from '@/components/lab/stage'
import { ProjectLabel } from '@/components/lab/project-label'
import { TagChip } from '@/components/lab/tag-chip'
import { SubjectTitle } from '@/components/lab/subject-title'
import { ConclusionCallout } from '@/components/lab/conclusion-callout'
import { WriteUp } from '@/components/lab/writeup'
import { WriteUpAside } from '@/components/lab/writeup-aside'
import { SubjectProperties } from '@/components/lab/subject-properties'
import { TodosPanel } from '@/components/lab/todos-panel'
import { HumanNotesPanel } from '@/components/lab/human-notes-panel'
import { FilesPanel } from '@/components/lab/files-panel'
import { LogPanel } from '@/components/lab/log-panel'
import { SubjectWorkspace } from '@/components/lab/subject-workspace'
import { isSubjectTab } from '@/lib/lab/ui-subject-tabs'
import { counts } from '@/components/lab/todo-lanes'

export const dynamic = 'force-dynamic'

// Deduped against the page's own lookup (React cache(), same request).
const cachedSubject = cache(getSubject)

export const generateMetadata = async ({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> => {
  const n = parseSubjectRef((await params).number)
  if (n === null) return { title: 'Subject' }
  const subject = await cachedSubject(n)
  return { title: subject ? `${subject.ref} ${subject.title}` : `S-${n}` }
}

/**
 * A subject, across the whole width: a header band (where it stands, what it
 * is called, who has it), then its sections — write-up, todos, notes, log,
 * files — as tabs over one wide working area, with its properties in a slim
 * rail. The write-up keeps a reading measure and the outline, open work and
 * latest notes sit beside it, so a wide screen is used rather than margined.
 * `S-12` and `12` both resolve; `?tab=todos&view=board` opens a section.
 */
const SubjectPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>
  searchParams: Promise<{ tab?: string; view?: string }>
}) => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const n = parseSubjectRef((await params).number)
  if (n === null) notFound()
  const subject = await cachedSubject(n)
  if (!subject) notFound()
  const query = await searchParams

  const [log, todos, humanNotes, files, stages, tags, projects, cairn] = await Promise.all([
    listSubjectNotes(subject.id),
    // The lab's todo rows, not the bare subject list: they carry priority and assignee.
    listLabTodos({ subject: subject.id, includeClosed: true }),
    listSubjectHumanNotes(subject.id),
    listSubjectAttachments(subject.id),
    listStages(),
    listTags(),
    listLabProjects(),
    getCairnConnection(),
  ])

  const tally = counts(todos)
  const isAdmin = user.role === 'admin'

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-11 shrink-0 items-center gap-1.5 border-b px-3 md:px-6 pr-live-status">
        <MobileNavButton />
        <Link href="/" className="text-fg-muted hover:text-fg text-[0.8125rem] transition-colors">
          Lab
        </Link>
        <ChevronRight size={12} className="text-fg-subtle shrink-0" aria-hidden />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden min-w-0 text-[0.8125rem] transition-colors sm:block"
          title={`All subjects; this one is at ${subject.stage.name}`}
        >
          <StageBadge stage={subject.stage} />
        </Link>
        <ChevronRight size={12} className="text-fg-subtle hidden shrink-0 sm:block" aria-hidden />
        <span className="text-fg-subtle shrink-0 font-mono text-[0.71875rem]">{subject.ref}</span>
        <span className="text-fg-muted hidden max-w-[48ch] truncate text-[0.8125rem] md:block">{subject.title}</span>
        {subject.archived_at ? (
          <span className="border-border text-fg-subtle ml-1 rounded border px-1.5 py-px text-[0.625rem] tracking-wide uppercase">
            Archived
          </span>
        ) : null}
      </header>

      <div data-scroll-root className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pt-5 pb-4 md:px-6 md:pt-6">
          <div className="text-fg-subtle mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem]">
            <span className="font-mono">{subject.ref}</span>
            <span aria-hidden>·</span>
            <StageBadge stage={subject.stage} className="text-fg-muted" />
            {subject.project ? (
              <>
                <span aria-hidden>·</span>
                <Link
                  href={`/?project=${encodeURIComponent(subject.project.name)}`}
                  title={`Every subject in ${subject.project.name}`}
                  className="rounded-[5px] transition-opacity hover:opacity-80"
                >
                  <ProjectLabel project={subject.project} />
                </Link>
              </>
            ) : null}
            <span aria-hidden className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">
              Opened <RelativeTime iso={subject.created_at} /> by <span className="text-fg-muted">{subject.actor_id}</span>
            </span>
            <span aria-hidden className="hidden md:inline">·</span>
            <span className="hidden md:inline">
              updated <RelativeTime iso={subject.updated_at} />
            </span>
          </div>

          <div className="max-w-[64rem]">
            <SubjectTitle subjectRef={subject.ref} initial={subject.title} />
          </div>

          {subject.owner || subject.tags.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {subject.owner ? (
                <span className="text-fg-muted mr-1 flex items-center gap-1.5 text-[0.75rem]">
                  <Avatar name={subject.owner.name} size={16} />
                  {subject.owner.name}
                </span>
              ) : null}
              {subject.tags.map((tag) => (
                <TagChip key={tag.id} tag={tag} />
              ))}
            </div>
          ) : null}

          {subject.conclusion ? (
            <div className="mt-4 max-w-[64rem]">
              <ConclusionCallout
                subjectRef={subject.ref}
                conclusion={subject.conclusion}
                concludedAt={subject.concluded_at}
                stage={subject.stage}
              />
            </div>
          ) : null}
        </div>

        <SubjectWorkspace
          initialTab={isSubjectTab(query.tab) ? query.tab : 'writeup'}
          counts={{ todos: tally.open || todos.length, notes: humanNotes.length, log: log.length, files: files.length }}
          panels={{
            writeup: (
              <div className="grid gap-8 xl:grid-cols-[minmax(0,48rem)_minmax(15rem,20rem)] xl:justify-between 2xl:gap-12">
                <WriteUp subjectRef={subject.ref} title={subject.title} body={subject.body} />
                <aside aria-label="At a glance" className="xl:sticky xl:top-[3.5rem] xl:self-start">
                  <WriteUpAside body={subject.body} todos={todos} notes={humanNotes} />
                </aside>
              </div>
            ),
            todos: (
              <TodosPanel
                subjectRef={subject.ref}
                todos={todos}
                cairnUrl={cairn.url}
                initialView={query.view === 'board' ? 'board' : 'list'}
              />
            ),
            notes: <HumanNotesPanel subjectRef={subject.ref} notes={humanNotes} isAdmin={isAdmin} />,
            log: (
              <div className="max-w-[52rem]">
                <LogPanel subjectRef={subject.ref} notes={log} />
              </div>
            ),
            files: <FilesPanel subjectRef={subject.ref} files={files} />,
          }}
          rail={
            <SubjectProperties
              subject={subject}
              stages={stages}
              tags={tags}
              projects={projects}
              canCreateTags={isAdmin}
            />
          }
        />
      </div>
      <LiveUpdates />
    </div>
  )
}

export default SubjectPage

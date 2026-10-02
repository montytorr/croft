import type { Metadata } from 'next'
import { cache } from 'react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { CheckSquare, ChevronRight, MessageSquare, Paperclip } from 'lucide-react'
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
import type { Viewer } from '@/lib/api/visibility'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { LiveUpdates } from '@/components/live-updates'
import { Avatar } from '@/components/icons'
import { RelativeTime } from '@/components/relative-time'
import { StageBadge } from '@/components/lab/stage'
import { ProjectLabel } from '@/components/lab/project-label'
import { TagChip } from '@/components/lab/tag-chip'
import { SubjectTitle } from '@/components/lab/subject-title'
import { VisibilityBadge } from '@/components/lab/visibility'
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

// Deduped against the page's own lookup (React cache(), same request). Keyed
// on primitives: cache() compares arguments by identity, and a viewer object
// built in each caller would never match.
const cachedSubject = cache((n: number, viewerId: string, role: Viewer['role']) =>
  getSubject(n, { id: viewerId, role }),
)

// Through the same gate as the page: a title is enough to leak a private subject.
export const generateMetadata = async ({ params }: { params: Promise<{ number: string }> }): Promise<Metadata> => {
  const n = parseSubjectRef((await params).number)
  if (n === null) return { title: 'Subject' }
  const user = await currentUser()
  if (!user) return { title: `S-${n}` }
  const subject = await cachedSubject(n, user.id, user.role)
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

  const viewer: Viewer = { id: user.id, role: user.role }
  const n = parseSubjectRef((await params).number)
  if (n === null) notFound()
  const subject = await cachedSubject(n, user.id, user.role)
  if (!subject) notFound()
  const query = await searchParams

  const [log, todos, humanNotes, files, stages, tags, projects, cairn] = await Promise.all([
    listSubjectNotes(subject.id, viewer),
    // The lab's todo rows, not the bare subject list: they carry priority and assignee.
    listLabTodos({ subject: subject.id, includeClosed: true }, viewer),
    listSubjectHumanNotes(subject.id, viewer),
    listSubjectAttachments(subject.id, viewer),
    listStages(),
    listTags(),
    listLabProjects(viewer),
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
        <VisibilityBadge visibility={subject.visibility} members={subject.members.length} className="ml-1" />
        {subject.archived_at ? (
          <span className="border-border text-fg-subtle ml-1 rounded border px-1.5 py-px text-[0.625rem] tracking-wide uppercase">
            Archived
          </span>
        ) : null}
      </header>

      <div data-scroll-root className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="subject-hero px-4 pt-7 pb-6 md:px-7 md:pt-9 md:pb-7">
          <div className="text-fg-subtle mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem]">
            <span className="border-border bg-surface rounded-md border px-2 py-1 font-mono text-[0.6875rem]">{subject.ref}</span>
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
          </div>

          <div className="flex items-center gap-8">
            <div className="min-w-0 max-w-[58rem] flex-1">
              <SubjectTitle subjectRef={subject.ref} initial={subject.title} />
            </div>
            {tally.open + tally.done > 0 ? (
              <div className="border-border bg-surface/70 hidden w-44 shrink-0 rounded-xl border p-4 xl:block">
                <p className="pane-label">Todo progress</p>
                <p className="text-fg mt-2 font-serif text-[1.875rem] leading-none tabular-nums">{tally.done}<span className="text-fg-subtle font-sans text-[0.8125rem]"> / {tally.open + tally.done} done</span></p>
                <div role="progressbar" aria-label="Completed todos" aria-valuenow={tally.done} aria-valuemin={0} aria-valuemax={tally.open + tally.done} className="bg-surface-raised mt-3 h-1 overflow-hidden rounded-full">
                  <div className="bg-status-done h-full rounded-full" style={{ width: `${tally.done / (tally.open + tally.done) * 100}%` }} />
                </div>
              </div>
            ) : null}
          </div>

          {subject.owner || subject.tags.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {subject.owner ? (
                <span className="text-fg-muted mr-1 flex items-center gap-1.5 text-[0.75rem]">
                  <Avatar name={subject.owner.name} size={20} />
                  {subject.owner.name}
                </span>
              ) : null}
              {subject.tags.map((tag) => (
                <TagChip key={tag.id} tag={tag} />
              ))}
            </div>
          ) : null}

          <div className="text-fg-subtle mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.71875rem]">
            <span className="flex items-center gap-1.5"><CheckSquare size={13} aria-hidden />{tally.open} open {tally.open === 1 ? 'todo' : 'todos'}</span>
            <span className="flex items-center gap-1.5"><MessageSquare size={13} aria-hidden />{humanNotes.length} {humanNotes.length === 1 ? 'note' : 'notes'}</span>
            <span className="flex items-center gap-1.5"><Paperclip size={13} aria-hidden />{files.length} {files.length === 1 ? 'file' : 'files'}</span>
            <span className="sm:ml-auto">Updated <RelativeTime iso={subject.updated_at} /></span>
          </div>

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
              <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_14rem] 2xl:grid-cols-[minmax(0,1fr)_17rem] 2xl:gap-6">
                <WriteUp subjectRef={subject.ref} title={subject.title} body={subject.body} />
                <aside aria-label="At a glance" className="xl:sticky xl:top-[4.75rem] xl:self-start">
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
              isAdmin={isAdmin}
            />
          }
        />
      </div>
      <LiveUpdates />
    </div>
  )
}

export default SubjectPage

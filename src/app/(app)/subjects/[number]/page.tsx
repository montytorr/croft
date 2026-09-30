import type { Metadata } from 'next'
import { cache } from 'react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser } from '@/lib/data'
import { getSubject, listLabProjects, listStages, listSubjectNotes, listSubjectTodos, listTags } from '@/lib/lab/data'
import { parseSubjectRef } from '@/lib/lab/types'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { LiveUpdates } from '@/components/live-updates'
import { StageBadge } from '@/components/lab/stage'
import { ProjectLabel } from '@/components/lab/project-label'
import { SubjectTitle } from '@/components/lab/subject-title'
import { ConclusionCallout } from '@/components/lab/conclusion-callout'
import { WriteUp } from '@/components/lab/writeup'
import { SubjectProperties } from '@/components/lab/subject-properties'
import { TodosPanel } from '@/components/lab/todos-panel'
import { LogPanel } from '@/components/lab/log-panel'

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
 * A subject: its conclusion (when it has one), its write-up, and its log, in
 * a reading column; its properties and todos in the pane beside it. `S-12`
 * and `12` both resolve.
 */
const SubjectPage = async ({ params }: { params: Promise<{ number: string }> }) => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const n = parseSubjectRef((await params).number)
  if (n === null) notFound()
  const subject = await cachedSubject(n)
  if (!subject) notFound()

  const [notes, todos, stages, tags, projects] = await Promise.all([
    listSubjectNotes(subject.id),
    listSubjectTodos(subject.id),
    listStages(),
    listTags(),
    listLabProjects(),
  ])

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[3.25rem] shrink-0 items-center gap-1.5 border-b px-3 md:px-6 pr-live-status">
        <MobileNavButton />
        <Link href="/" className="text-fg-muted hover:text-fg text-[0.8125rem] transition-colors">
          Lab
        </Link>
        <ChevronRight size={13} className="text-fg-subtle shrink-0" aria-hidden />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden min-w-0 text-[0.8125rem] transition-colors sm:block"
          title={`All subjects; this one is at ${subject.stage.name}`}
        >
          <StageBadge stage={subject.stage} />
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden shrink-0 sm:block" aria-hidden />
        <span className="text-fg-subtle shrink-0 font-mono text-[0.75rem]">{subject.ref}</span>
        <span className="text-fg hidden max-w-[40ch] truncate text-[0.8125rem] md:block">{subject.title}</span>
        {subject.archived_at ? (
          <span className="border-border text-fg-subtle ml-1 rounded border px-1.5 py-px text-[0.625rem] tracking-wide uppercase">
            Archived
          </span>
        ) : null}
      </header>

      {/* One scroll on a phone, the pane stacked under the page; two beside
          each other from lg, each scrolling on its own. */}
      <div className="min-h-0 flex-1 overflow-y-auto lg:flex lg:overflow-hidden">
        <main className="min-w-0 lg:flex-1 lg:overflow-y-auto">
          <article className="mx-auto max-w-[46rem] px-5 pt-8 pb-16 sm:px-8 lg:pt-12">
            <p className="text-fg-subtle mb-3 flex items-center gap-2 text-[0.75rem]">
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
            </p>
            <SubjectTitle subjectRef={subject.ref} initial={subject.title} />

            {subject.tags.length > 0 || subject.owner ? (
              <p className="text-fg-subtle mt-3 text-[0.8125rem]">
                {subject.owner ? (
                  <>
                    Owned by <span className="text-fg-muted">{subject.owner.name}</span>
                  </>
                ) : null}
                {subject.owner && subject.tags.length > 0 ? <span aria-hidden> · </span> : null}
                {subject.tags.map((t) => t.name).join(', ')}
              </p>
            ) : null}

            {subject.conclusion ? (
              <div className="mt-8">
                <ConclusionCallout
                  subjectRef={subject.ref}
                  conclusion={subject.conclusion}
                  concludedAt={subject.concluded_at}
                  stage={subject.stage}
                />
              </div>
            ) : null}

            <div className="mt-10">
              <WriteUp subjectRef={subject.ref} title={subject.title} body={subject.body} />
            </div>

            <div className="border-border mt-14 border-t pt-8">
              <LogPanel subjectRef={subject.ref} notes={notes} />
            </div>
          </article>
        </main>

        <aside
          aria-label="Properties and todos"
          className="border-border bg-bg-elevated shrink-0 overflow-x-hidden border-t lg:w-[21rem] lg:overflow-y-auto lg:border-t-0 lg:border-l"
        >
          <div className="flex flex-col gap-8 px-5 py-6 sm:px-8 lg:px-6 lg:py-8">
            <SubjectProperties
              subject={subject}
              stages={stages}
              tags={tags}
              projects={projects}
              canCreateTags={user.role === 'admin'}
            />
            <div className="border-border border-t pt-6">
              <TodosPanel subjectRef={subject.ref} todos={todos} />
            </div>
          </div>
        </aside>
      </div>
      <LiveUpdates />
    </div>
  )
}

export default SubjectPage

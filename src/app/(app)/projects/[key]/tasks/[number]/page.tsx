import type { Metadata } from 'next'
import { cache } from 'react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import {
  currentUser, getDuplicateOf, getParent, getTask, listActivity,
  listTaskAttachments,
  listChildren, listComments, listNotes,
} from '@/lib/data'
import { MarkdownEditor } from '@/components/markdown-editor'
import { MarkdownView } from '@/components/markdown'
import { ProjectIcon, StatusIcon } from '@/components/icons'
import { BrandName } from '@/components/brand'
import { RelativeTime } from '@/components/relative-time'
import { isTerminal } from '@/schemas/task'
import { cn } from '@/lib/utils'
import { Properties } from './properties'
import { EditableTitle } from './editable-title'
import { LiveUpdates } from '@/components/live-updates'
import { NotesPanel } from './notes-panel'
import { CommentsPanel } from './comments-panel'
import { AttachmentsPanel } from './attachments-panel'
import { ActivityPanel } from './activity-panel'
import { ChildrenPanel } from './children-panel'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { LABEL, PANE } from './styles'
import { getSubject } from '@/lib/lab/data'
import { ProjectLabel } from '@/components/lab/project-label'
import { VisibilityBadge } from '@/components/lab/visibility'
import { TODO_PROJECT_KEY } from '@/lib/lab/types'
import type { Viewer } from '@/lib/api/visibility'

export const dynamic = 'force-dynamic'

// Deduped against the page's own lookup below (React cache(), same request).
// Keyed on primitives: cache() compares arguments by identity.
const cachedTask = cache((userId: string, key: string, number: number, role: Viewer['role']) =>
  getTask(userId, key, number, { id: userId, role }),
)

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ key: string; number: string }>
}): Promise<Metadata> => {
  const { key, number } = await params
  const parsed = Number(number)
  const ref = `${key.toUpperCase()}-${number}`
  if (!Number.isInteger(parsed)) return { title: ref }
  // Signed in or no title: the layout turns everyone else away, but metadata
  // is resolved alongside it, not after it.
  const user = await currentUser()
  if (!user) return { title: ref }
  const task = await cachedTask(user.id, key, parsed, user.role)
  if (!task) return { title: ref }
  const title = `${ref} · ${task.title}`
  return { title: title.length > 60 ? `${title.slice(0, 59)}…` : title }
}

/**
 * A note set above the body: a flat panel with a solid stripe down its left
 * edge in the note's own colour, so a blocked task, a duplicate and an answer
 * are told apart before a word is read.
 */
const Callout = ({
  tone,
  className,
  children,
}: {
  tone: string
  className?: string
  children: React.ReactNode
}) => (
  <div className={cn('surface-card relative mb-4 overflow-hidden py-2 pr-3 pl-3.5', className)}>
    <span aria-hidden className="absolute inset-y-0 left-0 w-[2px]" style={{ backgroundColor: tone }} />
    {children}
  </div>
)

const Dot = () => (
  <span aria-hidden className="text-fg-subtle">
    ·
  </span>
)

const TaskPage = async ({
  params,
}: {
  params: Promise<{ key: string; number: string }>
}) => {
  const { key, number } = await params
  const user = await currentUser()
  if (!user) redirect('/login')

  const parsed = Number(number)
  if (!Number.isInteger(parsed)) notFound()

  const viewer: Viewer = { id: user.id, role: user.role }
  const task = await cachedTask(user.id, key, parsed, user.role)
  if (!task) notFound()

  const [
    notes, comments, attachments, duplicateOf, activity, children, parent,
    subject,
  ] = await Promise.all([
    listNotes(task.id, viewer),
    listComments(task.id, viewer),
    // With a kind each and a stable content_url, so previews never expire on an open page.
    listTaskAttachments(task.id, viewer),
    task.duplicate_of ? getDuplicateOf(task.duplicate_of, viewer) : Promise.resolve(null),
    listActivity(task.id, viewer),
    listChildren(task.id, viewer),
    task.parent_id ? getParent(task.parent_id, viewer) : Promise.resolve(null),
    // For the subject's lab project on the chip above the title.
    task.subject ? getSubject(task.subject.number, viewer).catch(() => null) : Promise.resolve(null),
  ])

  // The Croft ref, never the imported one. Preferring external_ref showed a
  // migrated task as LEGACY-1234 — an identifier that resolves nowhere in this
  // system, on the page whose whole job is to tell you what you are looking at.
  const ref = `${task.project.key}-${task.number}`

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-ui transition-colors lg:block"
        >
          <BrandName />
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden lg:block" aria-hidden />
        {task.subject ? (
          <Link
            href={`/subjects/${task.subject.number}`}
            className="text-fg-muted hover:text-fg flex min-w-0 shrink items-center gap-1.5 text-ui transition-colors"
            title={`Part of ${task.subject.ref}`}
          >
            <span className="font-mono text-aux">{task.subject.ref}</span>
            <span className="truncate">{task.subject.title}</span>
          </Link>
        ) : (
          // No subject: the todo's project, leading to the list of all todos —
          // the project page this used to lead to went with the Projects menu.
          <Link
            href="/todos"
            className="text-fg-muted hover:text-fg flex min-w-0 shrink items-center gap-1.5 text-ui transition-colors"
          >
            <ProjectIcon size={13} projectKey={task.project.key} />
            <span className="truncate">{task.project.title}</span>
          </Link>
        )}
        <ChevronRight size={13} className="text-fg-subtle hidden shrink-0 sm:block" aria-hidden />
        {parent ? (
          <>
            <Link
              href={`/projects/${parent.ref.slice(0, parent.ref.lastIndexOf('-'))}/tasks/${parent.ref.slice(parent.ref.lastIndexOf('-') + 1)}`}
              prefetch
              className="text-fg-muted hover:text-fg hidden max-w-[22ch] truncate text-ui transition-colors sm:block"
              title={parent.title}
            >
              {parent.title}
            </Link>
            <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
          </>
        ) : null}
        <span className="text-fg-subtle shrink-0 text-ui tabular">{ref}</span>
        {/* Where it came from, kept visible rather than substituted for the
            ref: matching a task against the Linear export is a real need, and
            it is the only place that identifier now appears. */}
        {task.external_ref ? (
          <span
            className="text-fg-subtle hidden shrink-0 text-aux tabular sm:inline"
            title={`Imported as ${task.external_ref}`}
          >
            ({task.external_ref})
          </span>
        ) : null}
        <span className="text-fg hidden max-w-[38ch] truncate text-ui sm:block">
          {task.title}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col-reverse lg:flex-row">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="max-w-[72rem] px-4 py-5 sm:px-6 lg:px-8">
            {/* The ref and the project, quiet above the title rather than
                competing with it: the title is the page's one voice. */}
            <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="border-border bg-surface-raised text-fg-muted inline-flex h-[1.25rem] shrink-0 items-center rounded-md border px-1.5 font-mono text-aux">
                {ref}
              </span>
              {task.subject ? (
                // What this todo is for. The todos project every todo lives in
                // says nothing; the subject says everything.
                <Link
                  href={`/subjects/${task.subject.number}`}
                  className="border-border text-fg-muted hover:text-fg hover:border-border-strong hover:bg-surface-hover inline-flex h-[1.25rem] min-w-0 items-center gap-1.5 rounded-md border pr-2 pl-1.5 text-aux transition-colors duration-[var(--dur-1)] ease-[var(--ease-out)]"
                  title={`Part of ${task.subject.ref}`}
                >
                  <span className="text-fg-subtle font-mono text-aux">{task.subject.ref}</span>
                  <span className="max-w-[40ch] truncate">{task.subject.title}</span>
                </Link>
              ) : null}
              {subject?.project ? (
                <Link href={`/?project=${encodeURIComponent(subject.project.name)}`} className="min-w-0">
                  <ProjectLabel project={subject.project} />
                </Link>
              ) : null}
              {/* A todo is exactly as visible as its subject: say so where it is worked. */}
              {subject ? <VisibilityBadge visibility={subject.visibility} members={subject.members.length} /> : null}
              {!task.subject || task.project.key !== TODO_PROJECT_KEY ? (
                <Link
                  href="/todos"
                  className="border-border text-fg-muted hover:text-fg hover:border-border-strong hover:bg-surface-hover inline-flex h-[1.25rem] min-w-0 items-center gap-1.5 rounded-full border pr-2 pl-1.5 text-aux transition-colors duration-[var(--dur-1)] ease-[var(--ease-out)]"
                >
                  <ProjectIcon size={11} projectKey={task.project.key} />
                  <span className="truncate">{task.project.title}</span>
                </Link>
              ) : null}
            </div>

            <EditableTitle taskId={task.id} initial={task.title} />

            {/* First thing on the page when it applies: a reader who opens a
                duplicate wants redirecting, not reading. */}
            {duplicateOf ? (
              <Callout tone="var(--fg-subtle)">
                <p className="text-fg-muted text-ui">
                  Duplicate of{' '}
                  <Link
                    href={`/projects/${duplicateOf.ref.slice(0, duplicateOf.ref.lastIndexOf('-'))}/tasks/${duplicateOf.ref.slice(duplicateOf.ref.lastIndexOf('-') + 1)}`}
                    prefetch
                    className="text-accent decoration-accent/50 underline-offset-[3px] hover:underline"
                  >
                    {duplicateOf.ref}
                  </Link>{' '}
                  — {duplicateOf.title}
                </p>
              </Callout>
            ) : null}

            {task.blocked_reason ? (
              <Callout tone="var(--danger)">
                <p className="text-danger text-aux">Blocked: {task.blocked_reason}</p>
              </Callout>
            ) : null}

            {/* Above the body on purpose: when a future agent opens a closed
                task, the answer is what it came for — so it is the one card on
                the page edged in its status's colour. */}
            {task.resolution ? (
              <Callout tone={`var(--status-${task.status})`} className="mb-5 py-2.5 pr-4 pl-[1.125rem]">
                <p className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-aux">
                  <StatusIcon status={task.status} size={12} />
                  <span className="font-medium" style={{ color: `var(--status-${task.status})` }}>
                    {isTerminal(task.status) ? 'Resolved' : 'Resolution'}
                  </span>
                  {task.resolution_kind ? (
                    <>
                      <Dot />
                      <span className="text-fg-muted">{task.resolution_kind}</span>
                    </>
                  ) : null}
                  {task.resolved_by ? (
                    <>
                      <Dot />
                      <span className="text-fg-muted">{task.resolved_by}</span>
                    </>
                  ) : null}
                  {task.resolved_at ? (
                    <>
                      <Dot />
                      <RelativeTime iso={task.resolved_at} className="text-fg-subtle" />
                    </>
                  ) : null}
                </p>
                <MarkdownView>{task.resolution}</MarkdownView>
              </Callout>
            ) : null}

            {task.checkpoint_summary && !task.resolution ? (
              <Callout tone="var(--fg-subtle)" className="mb-5 py-2">
                <p className={cn(LABEL, 'mb-1')}>Last checkpoint</p>
                <p className="text-fg-muted text-ui">{task.checkpoint_summary}</p>
              </Callout>
            ) : null}

            <div className="mb-5">
              <MarkdownEditor taskId={task.id} initial={task.description ?? ''} />
            </div>

            {/* Ruled rather than spaced. Five panels separated by 40px of air
                was most of the dead space on this page; a divider does the
                same job of separating them and reads as structure. Ordered by
                what a reader wants next: the split, then the evidence, then
                the conversation, then the audit trail. */}
            <div className="[&>*+*]:border-border flex flex-col [&>*]:py-4 [&>*+*]:border-t">
              <ChildrenPanel
                taskRef={`${task.project.key}-${task.number}`}
                projectKey={task.project.key}
                items={children}
              />
              <AttachmentsPanel taskId={task.id} attachments={attachments} />
              <NotesPanel taskId={task.id} notes={notes} />
              <CommentsPanel taskId={task.id} comments={comments} />
              <ActivityPanel entries={activity} />
            </div>
          </div>
        </div>

        {/* Fixed width AND `overflow-x-hidden` set here, not left to the
            column inside: `overflow-y-auto` alone computes `overflow-x` as
            `auto` too (CSS's rule for a lone non-`visible` axis), so any
            child that refused to shrink turned this pane into a horizontal
            scroller — pinning both here forecloses that regardless of what
            the column renders. */}
        <div
          className={cn(
            PANE,
            'hidden w-[18rem] shrink-0 overflow-x-hidden overflow-y-auto lg:block',
          )}
        >
          <Properties
            task={task}
            project={task.project}
            parent={parent}
          />
        </div>
      </div>
      <LiveUpdates projectKey={task.project.key} />
    </div>
  )
}

export default TaskPage

'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { Columns3, List, Lock, Plus, Search, X } from 'lucide-react'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { EmptyState } from '@/components/empty-state'
import { Spinner } from '@/components/spinner'
import { Button } from '@/components/ui/control'
import { cn } from '@/lib/utils'
import { rememberLabView, type LabView as View } from '@/lib/lab/ui-view'
import type { LabProject, Stage, SubjectSummary, Tag } from '@/lib/lab/types'
import { matchProjectFilter } from '@/lib/lab/ui-colours'
import { useCreateSubject } from '@/components/subject-creation'
import { LabBoard } from './lab-board'
import { LabList } from './lab-list'
import { ProjectLabel } from './project-label'
import { TagChip } from './tag-chip'

export type LabFilters = {
  project: string
  tag: string
  owner: 'me' | 'all'
  /** Only subjects not yet in the lab: the viewer's private ones and those shared with them. */
  restricted: boolean
  q: string
}

const labUrl = ({ project, tag, owner, restricted, q }: LabFilters) => {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  if (tag) params.set('tag', tag)
  if (owner === 'me') params.set('owner', 'me')
  if (restricted) params.set('private', '1')
  if (q.trim()) params.set('q', q.trim())
  const qs = params.toString()
  return qs ? `/?${qs}` : '/'
}

const Segmented = <T extends string>({
  value,
  options,
  onPick,
  label,
}: {
  value: T
  options: { value: T; label: string; icon?: typeof List }[]
  onPick: (v: T) => void
  label: string
}) => (
  <div role="group" aria-label={label} className="bg-surface-raised flex shrink-0 items-center gap-0.5 rounded-lg p-0.5">
    {options.map(({ value: v, label: text, icon: Icon }) => (
      <button
        key={v}
        type="button"
        aria-pressed={value === v}
        onClick={() => onPick(v)}
        title={text}
        className={cn(
          'flex h-[1.625rem] items-center gap-1.5 rounded-md px-2 text-[0.75rem] transition-[background-color,color,box-shadow] duration-[var(--dur-2)] ease-[var(--ease-out)]',
          value === v ? 'bg-surface text-fg ring-border shadow-[var(--shadow-sm)] ring-1' : 'text-fg-muted hover:text-fg',
        )}
      >
        {Icon ? <Icon size={13} aria-hidden /> : null}
        <span className={cn(Icon && 'sr-only sm:not-sr-only')}>{text}</span>
      </button>
    ))}
  </div>
)

/**
 * The lab: every subject, as a list grouped by stage or as a board of stage
 * lanes. The view is remembered per browser (a cookie, so the server renders
 * the same one the client hydrates). Filters live in the URL, so a filtered
 * lab is a link someone can be sent.
 */
export const LabView = ({
  subjects,
  stages,
  tags,
  projects,
  initialView,
  filters,
}: {
  subjects: SubjectSummary[]
  stages: Stage[]
  tags: Tag[]
  projects: LabProject[]
  initialView: View | null
  filters: LabFilters
}) => {
  const router = useRouter()
  const { open: newSubject } = useCreateSubject()
  const [view, setView] = useState<View>(initialView ?? 'list')
  const [query, setQuery] = useState(filters.q)
  const [running, start] = useTransition()
  const searchRef = useRef<HTMLInputElement>(null)

  const push = (next: Partial<LabFilters>) =>
    start(() => router.replace(labUrl({ ...filters, q: query, ...next }), { scroll: false }))

  // The text filter follows typing, a beat behind it.
  const { project, tag, owner, restricted, q } = filters
  useEffect(() => {
    if (query === q) return
    const timer = setTimeout(
      () => start(() => router.replace(labUrl({ project, tag, owner, restricted, q: query }), { scroll: false })),
      280,
    )
    return () => clearTimeout(timer)
  }, [query, q, project, tag, owner, restricted, router])

  // `/` focuses the filter, as it does on every list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const pickView = (next: View) => {
    setView(next)
    rememberLabView(next)
  }

  const active = subjects.filter((s) => s.stage.category === 'active').length
  const planned = subjects.filter((s) => s.stage.category === 'planned').length
  const concluded = subjects.length - active - planned
  const filtered = Boolean(filters.project || filters.tag || filters.owner === 'me' || filters.restricted || filters.q)
  // Matched by name, any case, or id, as the API does — so a link typed by hand
  // still lights its chip.
  const pickedProject = matchProjectFilter(filters.project, projects)

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[3.25rem] shrink-0 items-center gap-3 border-b px-3 md:px-6 pr-live-status">
        <MobileNavButton />
        <h1 className="font-display headline text-fg text-[1.125rem]">Lab</h1>
        <p className="text-fg-subtle hidden items-center gap-3 text-[0.75rem] sm:flex">
          <span><span className="text-fg tabular-nums font-medium">{active}</span> being worked</span>
          <span><span className="text-fg tabular-nums font-medium">{planned}</span> planned</span>
          <span><span className="text-fg tabular-nums font-medium">{concluded}</span> concluded</span>
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Segmented
            label="View"
            value={view}
            onPick={pickView}
            options={[
              { value: 'list', label: 'List', icon: List },
              { value: 'board', label: 'Board', icon: Columns3 },
            ]}
          />
          <Button variant="primary" size="sm" onClick={newSubject} className="h-[1.875rem] px-3" title="New subject — c">
            <Plus size={14} aria-hidden />
            <span className="hidden sm:inline">New subject</span>
            <span className="hidden font-mono text-[0.6875rem] opacity-70 sm:inline">c</span>
          </Button>
        </div>
      </header>

      <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 md:px-6">
        <label className="relative flex w-full items-center sm:w-[15rem]">
          <Search size={13} aria-hidden className="text-fg-subtle pointer-events-none absolute left-2.5" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder="Filter subjects…"
            aria-label="Filter subjects"
            className="border-border bg-surface text-fg placeholder:text-fg-subtle hover:border-border-strong focus:border-accent h-[1.875rem] w-full rounded-md border pr-7 pl-8 text-[0.8125rem] outline-none transition-[border-color,box-shadow] focus:shadow-[0_0_0_1px_var(--accent)]"
          />
          {running ? (
            <span className="text-fg-subtle absolute right-2.5"><Spinner size={11} /></span>
          ) : query ? (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear the filter" className="text-fg-subtle hover:text-fg absolute right-2">
              <X size={12} aria-hidden />
            </button>
          ) : (
            <kbd className="kbd absolute right-2 hidden sm:inline-flex">/</kbd>
          )}
        </label>

        <Segmented
          label="Owner"
          value={filters.owner}
          onPick={(owner) => push({ owner })}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'me', label: 'Mine' },
          ]}
        />

        <button
          type="button"
          aria-pressed={filters.restricted}
          onClick={() => push({ restricted: !filters.restricted })}
          title="Subjects not yet published to the lab: your private ones and those shared with you"
          className={cn(
            'flex h-[1.875rem] shrink-0 items-center gap-1.5 rounded-lg px-2 text-[0.75rem] transition-[background-color,color,box-shadow] duration-[var(--dur-2)] ease-[var(--ease-out)]',
            filters.restricted
              ? 'bg-surface text-fg ring-border shadow-[var(--shadow-sm)] ring-1'
              : 'text-fg-muted hover:text-fg bg-surface-raised',
          )}
        >
          <Lock size={12} aria-hidden />
          <span className="sm:hidden">Private</span>
          <span className="hidden sm:inline">Private &amp; shared with me</span>
        </button>

        {projects.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="Filter by project">
            {projects.map((p) => {
              const on = pickedProject !== 'none' && pickedProject?.id === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => push({ project: on ? '' : p.name })}
                  className="rounded-[5px] transition-opacity hover:opacity-100"
                  style={{ opacity: filters.project && !on ? 0.6 : 1 }}
                >
                  <ProjectLabel project={p} active={on} />
                </button>
              )
            })}
            <button
              type="button"
              aria-pressed={pickedProject === 'none'}
              onClick={() => push({ project: pickedProject === 'none' ? '' : 'none' })}
              className={cn(
                'border-border h-[1.25rem] rounded-[5px] border border-dashed px-1.5 text-[0.6875rem] leading-none font-medium transition-[opacity,color]',
                pickedProject === 'none' ? 'text-fg border-border-strong bg-surface-raised' : 'text-fg-subtle hover:text-fg',
                filters.project && pickedProject !== 'none' && 'opacity-60 hover:opacity-100',
              )}
              title="Subjects that belong to no project"
            >
              No project
            </button>
          </div>
        ) : null}

        {projects.length > 0 && tags.length > 0 ? (
          <span className="bg-border hidden h-4 w-px shrink-0 sm:block" aria-hidden />
        ) : null}

        {tags.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1" role="group" aria-label="Filter by tag">
            {tags.map((tag) => {
              const on = filters.tag === tag.name
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => push({ tag: on ? '' : tag.name })}
                  className="rounded-full transition-opacity hover:opacity-100"
                  style={{ opacity: filters.tag && !on ? 0.6 : 1 }}
                >
                  <TagChip tag={tag} active={on} />
                </button>
              )
            })}
          </div>
        ) : null}

        {filtered ? (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              start(() => router.replace('/', { scroll: false }))
            }}
            className="text-fg-subtle hover:text-fg ml-auto text-[0.75rem] transition-colors"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {stages.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            as="h2"
            title="No stages yet"
            hint="An administrator sets the lab's stages in Settings — the pipeline every subject moves along."
          />
        </div>
      ) : subjects.length === 0 && !filtered ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            as="h2"
            title="The field is unploughed"
            hint="A subject is anything worth finding out about: a technology to try, a proof of concept, an idea to build."
            action={
              <Button variant="primary" size="sm" onClick={newSubject} className="px-3">
                <Plus size={14} aria-hidden /> New subject
              </Button>
            }
          />
        </div>
      ) : view === 'board' ? (
        <div className="min-h-0 flex-1">
          <LabBoard subjects={subjects} stages={stages} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {subjects.length === 0 ? (
            <EmptyState compact title="No subject matches these filters." />
          ) : (
            <LabList subjects={subjects} stages={stages} />
          )}
        </div>
      )}
    </div>
  )
}

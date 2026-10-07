'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { Columns3, List, Lock, Plus, Search, X } from 'lucide-react'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { EmptyState } from '@/components/empty-state'
import { Spinner } from '@/components/spinner'
import { Button, Input } from '@/components/ui/control'
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
          'flex h-9 items-center gap-1.5 rounded-md px-2 text-aux transition-[background-color,color,box-shadow] duration-[var(--dur-2)] ease-[var(--ease-out)]',
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
        <p className="text-fg-subtle hidden items-center gap-3 text-aux xl:flex">
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
          <Button variant="primary" size="sm" onClick={newSubject} title="New subject — c">
            <Plus size={14} aria-hidden />
            <span className="hidden sm:inline">New subject</span>
            <span className="hidden font-mono text-aux opacity-80 xl:inline">c</span>
          </Button>
        </div>
      </header>

      <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2.5 md:px-6">
        <label className="relative flex w-full items-center sm:w-[15rem]">
          <Search size={13} aria-hidden className="text-fg-subtle pointer-events-none absolute left-2.5" />
          <Input
            ref={searchRef}
            size="sm"
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
            className="pr-8 pl-8"
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
            'flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-2 text-aux transition-[background-color,color,box-shadow] duration-[var(--dur-2)] ease-[var(--ease-out)]',
            filters.restricted
              ? 'bg-surface text-fg ring-border shadow-[var(--shadow-sm)] ring-1'
              : 'text-fg-muted hover:text-fg bg-surface-raised',
          )}
        >
          <Lock size={12} aria-hidden />
          <span className="sm:hidden">Private</span>
          <span className="hidden sm:inline">Private &amp; shared with me</span>
        </button>

        {filtered ? (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              start(() => router.replace('/', { scroll: false }))
            }}
            className="text-accent hover:underline ml-auto h-10 px-1 text-aux font-medium underline-offset-4"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {projects.length > 0 || tags.length > 0 ? (
        <div className="border-border flex shrink-0 flex-col gap-2 border-b px-3 py-2.5 md:px-6">
        {projects.length > 0 ? (
          <div className="flex items-center gap-2" role="group" aria-label="Filter by project">
            <span className="pane-label w-[3.75rem] shrink-0">Project</span>
            <div className="scroll-hint flex min-w-0 items-center gap-1.5 overflow-x-auto py-0.5 pr-6 md:flex-wrap md:pr-0">
            {projects.map((p) => {
              const on = pickedProject !== 'none' && pickedProject?.id === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => push({ project: on ? '' : p.name })}
                  className="rounded-[5px] transition-opacity hover:opacity-100"
                 
                >
                  <ProjectLabel project={p} active={on} className="h-9 px-2.5" />
                </button>
              )
            })}
            <button
              type="button"
              aria-pressed={pickedProject === 'none'}
              onClick={() => push({ project: pickedProject === 'none' ? '' : 'none' })}
              className={cn(
                'control-chip shrink-0 font-medium',
                pickedProject === 'none' && 'text-fg bg-surface-raised border-accent',
              )}
              title="Subjects that belong to no project"
            >
              No project
            </button>
            </div>
          </div>
        ) : null}

        {tags.length > 0 ? (
          <div className="flex items-center gap-2" role="group" aria-label="Filter by tag">
            <span className="pane-label w-[3.75rem] shrink-0">Tag</span>
            <div className="scroll-hint flex min-w-0 items-center gap-1.5 overflow-x-auto py-0.5 pr-6 md:flex-wrap md:pr-0">
            {tags.map((tag) => {
              const on = filters.tag === tag.name
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => push({ tag: on ? '' : tag.name })}
                  className="rounded-full transition-opacity hover:opacity-100"
                 
                >
                  <TagChip tag={tag} active={on} className="h-8 px-3" />
                </button>
              )
            })}
            </div>
          </div>
        ) : null}
        </div>
      ) : null}

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
              <Button variant="primary" size="sm" onClick={newSubject}>
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

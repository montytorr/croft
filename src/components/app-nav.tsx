'use client'

import Link from 'next/link'
import { Suspense } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { matchProjectFilter } from '@/lib/lab/ui-colours'
import type { LabProject } from '@/lib/lab/types'
import { Activity, Columns3, FlaskConical, ListTodo, Plus, Search } from 'lucide-react'

/** A lab project as the sidebar lists it: its colour, its name, how many subjects it holds. */
export type NavProject = Pick<LabProject, 'id' | 'name' | 'color'> & { subjects: number }

const ROW = '1.875rem'

/**
 * The active entry's marker, drawn once and moved rather than drawn on each
 * row, so navigating slides it from the old entry to the new one. Rows are a
 * fixed 1.875rem, so its position is the index and nothing is measured. Hidden
 * when nothing in the list is active.
 */
const Marker = ({ index }: { index: number }) => (
  <span
    aria-hidden
    className={cn(
      'bg-surface-raised pointer-events-none absolute inset-x-0.5 top-0 h-[1.875rem] rounded-md',
      'transition-[transform,opacity] duration-[var(--dur-3)] ease-[var(--ease-out)]',
      'before:bg-accent before:absolute before:inset-y-[0.375rem] before:-left-[2px] before:w-[2px] before:rounded-full',
      index < 0 && 'opacity-0',
    )}
    style={{ transform: `translateY(calc(${Math.max(index, 0)} * ${ROW}))` }}
  />
)

const LINKS = [
  { href: '/', label: 'Lab', icon: FlaskConical },
  { href: '/todos', label: 'Todos', icon: ListTodo },
  { href: '/board', label: 'Todo board', icon: Columns3 },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/activity', label: 'Activity', icon: Activity },
]

/** Which entry a path belongs under. */
export const navEntryFor = (pathname: string): string | null => {
  // A subject's page is in the lab, so the lab stays lit there.
  if (pathname === '/' || pathname.startsWith('/subjects/')) return '/'
  // A todo's page lives under its (internal) task project; it is a todo.
  if (/^\/projects\/[^/]+\/tasks\//.test(pathname)) return '/todos'
  return LINKS.find(({ href }) => href !== '/' && pathname === href)?.href ?? null
}

/**
 * The lab project the lab is filtered to, if any: only on the lab itself, and
 * only for a project that exists (a hand-typed `?project=nope` lights nothing).
 */
export const activeProjectFor = (
  pathname: string,
  projectParam: string | null,
  projects: Pick<NavProject, 'id' | 'name'>[],
): string | null => {
  if (pathname !== '/') return null
  const match = matchProjectFilter(projectParam, projects)
  return match && match !== 'none' ? match.id : null
}

export const projectHref = (name: string) => `/?project=${encodeURIComponent(name)}`

/** An admin's colour is only trusted as a hex; anything else falls back to the quiet grey. */
const tone = (color: string) => (/^#[0-9a-f]{3,8}$/i.test(color) ? color : 'var(--fg-subtle)')

const linkClass = (active: boolean) =>
  cn(
    'group relative flex h-[1.875rem] items-center gap-2 rounded-md px-2 text-[0.8125rem]',
    'transition-colors duration-100 ease-[var(--ease)]',
    // The marker is the fill and the accent edge: a raised background alone
    // is a very quiet way to answer "where am I".
    active ? 'text-fg' : 'text-fg-muted hover:bg-surface-hover/70 hover:text-fg',
  )

const ProjectRows = ({
  projects,
  activeId,
  onNavigate,
}: {
  projects: NavProject[]
  activeId: string | null
  onNavigate?: () => void
}) => {
  const activeIndex = projects.findIndex((p) => p.id === activeId)
  return (
    <ul className="relative -mx-0.5">
      <Marker index={activeIndex} />
      {projects.map((p) => {
        const active = p.id === activeId
        return (
          <li key={p.id}>
            <Link
              href={projectHref(p.name)}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              title={`${p.name}: ${p.subjects} subject${p.subjects === 1 ? '' : 's'}`}
              className={linkClass(active)}
            >
              <span className="grid w-[13px] shrink-0 place-items-center" aria-hidden>
                <span
                  className={cn(
                    'size-[0.5rem] rounded-[2px] transition-transform duration-[var(--dur-2)] ease-[var(--ease-out)]',
                    !active && 'group-hover:scale-125',
                  )}
                  style={{ backgroundColor: tone(p.color) }}
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <span className="text-fg-subtle tabular shrink-0 text-[0.6875rem]">{p.subjects}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/** Reads the filter from the URL; split out so only this part waits on search params. */
const ActiveProjectRows = (props: { projects: NavProject[]; onNavigate?: () => void }) => {
  const pathname = usePathname()
  const params = useSearchParams()
  return <ProjectRows {...props} activeId={activeProjectFor(pathname, params.get('project'), props.projects)} />
}

const ProjectsGroup = ({
  projects,
  canManage,
  onNavigate,
}: {
  projects: NavProject[]
  canManage: boolean
  onNavigate?: () => void
}) => {
  if (projects.length === 0 && !canManage) return null

  return (
    <section aria-labelledby="nav-projects" className="mt-3">
      <div className="flex h-[1.5rem] items-center gap-1 pr-0.5 pl-2">
        <h2
          id="nav-projects"
          className="pane-label flex-1"
        >
          Projects
        </h2>
        {canManage ? (
          <Link
            href="/settings#lab-projects"
            onClick={onNavigate}
            aria-label="Add or edit lab projects"
            title="Lab projects, in Settings"
            className="text-fg-subtle hover:text-fg hover:bg-surface-hover grid size-[1.25rem] place-items-center rounded transition-colors duration-[var(--dur-1)]"
          >
            <Plus size={12} aria-hidden />
          </Link>
        ) : null}
      </div>

      {projects.length === 0 ? (
        <Link
          href="/settings#lab-projects"
          onClick={onNavigate}
          className="text-fg-subtle hover:text-fg flex h-[1.875rem] items-center px-2 text-[0.75rem] transition-colors"
        >
          Add the first project
        </Link>
      ) : (
        // Without the params the rows still render, just unlit, until they arrive.
        <Suspense fallback={<ProjectRows projects={projects} activeId={null} onNavigate={onNavigate} />}>
          <ActiveProjectRows projects={projects} onNavigate={onNavigate} />
        </Suspense>
      )}
    </section>
  )
}

/**
 * The app's places, then the lab's projects. A project is a filter on the lab
 * rather than a place of its own, so its row leads to the lab filtered to it
 * and lights only while that filter is on.
 */
const Places = ({ onNavigate, dimLab }: { onNavigate?: () => void; dimLab: boolean }) => {
  const pathname = usePathname()
  const current = navEntryFor(pathname)
  // Filtered to a project, the project's row is where you are; lighting the
  // lab as well would answer "where am I" twice.
  const lit = dimLab && current === '/' ? null : current
  const activeIndex = LINKS.findIndex(({ href }) => href === lit)

  return (
    <ul className="relative -mx-0.5">
      <Marker index={activeIndex} />
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = href === lit
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={linkClass(active)}
            >
              <Icon
                size={13}
                aria-hidden
                className={cn(
                  'transition-[color,transform] duration-[var(--dur-2)] ease-[var(--ease-out)]',
                  active ? 'text-accent' : 'group-hover:scale-110',
                )}
              />
              {label}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

const PlacesWithFilter = (props: { onNavigate?: () => void; projects: NavProject[] }) => {
  const pathname = usePathname()
  const params = useSearchParams()
  return (
    <Places onNavigate={props.onNavigate} dimLab={activeProjectFor(pathname, params.get('project'), props.projects) !== null} />
  )
}

export const AppNav = ({
  onNavigate,
  projects = [],
  canManageProjects = false,
}: {
  onNavigate?: () => void
  projects?: NavProject[]
  /** Admins get the "+" that leads to Settings → Lab projects. */
  canManageProjects?: boolean
}) => (
  <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
    <Suspense fallback={<Places onNavigate={onNavigate} dimLab={false} />}>
      <PlacesWithFilter onNavigate={onNavigate} projects={projects} />
    </Suspense>
    <ProjectsGroup projects={projects} canManage={canManageProjects} onNavigate={onNavigate} />
  </nav>
)

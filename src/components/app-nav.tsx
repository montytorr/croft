'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Activity, Columns3, FlaskConical, ListTodo, Search } from 'lucide-react'

/**
 * The active entry's marker, drawn once and moved rather than drawn on each
 * row, so navigating slides it from the old entry to the new one. Rows are a
 * fixed 2rem, so its position is the index and nothing is measured. Hidden
 * when nothing in the list is active.
 */
const Marker = ({ index }: { index: number }) => (
  <span
    aria-hidden
    className={cn(
      'bg-surface-raised pointer-events-none absolute inset-x-0.5 top-0 h-[2rem] rounded-md',
      'transition-[transform,opacity] duration-[var(--dur-3)] ease-[var(--ease-out)]',
      'before:bg-accent before:absolute before:inset-y-[0.375rem] before:-left-[2px] before:w-[2px] before:rounded-full',
      index < 0 && 'opacity-0',
    )}
    style={{ transform: `translateY(${Math.max(index, 0) * 2}rem)` }}
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
 * The app's places. Lab projects are a filter on the lab, not places of their
 * own, so the sidebar carries no project list.
 */
export const AppNav = ({ onNavigate }: { onNavigate?: () => void }) => {
  const pathname = usePathname()
  const current = navEntryFor(pathname)
  const activeIndex = LINKS.findIndex(({ href }) => href === current)

  return (
    <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2">
      <ul className="relative -mx-0.5 mb-2">
        <Marker index={activeIndex} />
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = href === current
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex h-[2rem] items-center gap-2 rounded-md px-2 text-[0.8125rem]',
                  'transition-colors duration-100 ease-[var(--ease)]',
                  // The marker (above) is the fill and the accent edge: a
                  // raised background alone is a very quiet way to answer
                  // "where am I".
                  active ? 'text-fg' : 'text-fg-muted hover:bg-surface-hover/70 hover:text-fg',
                )}
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
    </nav>
  )
}

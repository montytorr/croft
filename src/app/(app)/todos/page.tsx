import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/data'
import { listLabProjects, listLabTodos } from '@/lib/lab/data'
import { LiveUpdates } from '@/components/live-updates'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { TodosView } from './todos-view'
import { isClosed } from './lab-todos'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Todos' }

const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <span className="text-fg-subtle text-aux">
    <span className="text-fg tabular font-medium">{value}</span> {label}
  </span>
)

/** Enough for the lab's todos, closed ones included; open ones come first, so a cap drops the oldest closed. */
const LIMIT = 1500

const TodosPage = async ({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => {
  const params = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  // Loaded whole and filtered in the view, so switching project, subject or
  // grouping answers at once and the counts on the chips stay honest.
  const viewer = { id: user.id, role: user.role }
  const [todos, projects] = await Promise.all([
    listLabTodos({ includeClosed: true, limit: LIMIT }, viewer),
    listLabProjects(viewer).catch(() => []),
  ])

  const query = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])),
  ).toString()
  const open = todos.filter((t) => !isClosed(t.status))
  const held = open.filter((t) => t.claimed_by).length
  const handedOff = open.filter((t) => t.handoff).length

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <span className="text-fg shrink-0 text-ui font-medium">Todos</span>
        <span className="text-fg-subtle hidden text-ui sm:block">·</span>
        {/* The counts are the first thing to go on a phone — the list itself
            says more than a tally of it. */}
        <span className="hidden items-center gap-2.5 sm:flex">
          <Stat label="open" value={open.length} />
          {held > 0 ? <Stat label="held by an agent" value={held} /> : null}
          {handedOff > 0 ? <Stat label="handed off" value={handedOff} /> : null}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TodosView
          todos={todos}
          projects={projects.map(({ id, name, color }) => ({ id, name, color }))}
          initialQuery={query}
        />
      </div>

      <LiveUpdates />
    </div>
  )
}

export default TodosPage

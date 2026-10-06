import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { currentUser } from '@/lib/data'
import { searchAll, type SearchAllRow } from '@/lib/api/search'
import { BrandName } from '@/components/brand'
import { SearchControls } from './search-controls'
import { UnifiedResults } from './unified-results'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { EmptyState } from '@/components/empty-state'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Search' }

export const KINDS = ['all', 'subject', 'task', 'note'] as const
export type Kind = (typeof KINDS)[number]

const SearchPage = async ({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    kind?: string
  }>
}) => {
  const { q = '', kind } = await searchParams
  const user = await currentUser()
  if (!user) redirect('/login')

  const query = q.trim()

  let unified: SearchAllRow[] = []
  let widened = false
  let failure: string | null = null

  if (query.length >= 2) {
    try {
      ;({ rows: unified, widened } = await searchAll(
        user.id,
        query,
        { kinds: KINDS.includes(kind as Kind) && kind !== 'all' ? [kind as string] : undefined },
        60,
      ))
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Search failed.'
    }
  }

  const count = unified.length
  const resolved = unified.filter((r) => r.answered).length

  return (
    <div className="flex h-dvh flex-col">
      <header className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-1.5 border-b px-2.5 md:px-4 pr-live-status">
        <MobileNavButton />
        <Link
          href="/"
          className="text-fg-muted hover:text-fg hidden text-ui transition-colors sm:block"
        >
          <BrandName />
        </Link>
        <ChevronRight size={13} className="text-fg-subtle hidden sm:block" aria-hidden />
        <span className="text-fg text-ui">Search</span>
        {count > 0 && (
          <span className="text-fg-subtle ml-auto hidden text-aux tabular-nums sm:block">
            {count} {count === 1 ? 'result' : 'results'}
            {resolved > 0 ? ` · ${resolved} with a recorded answer` : ''}
            {widened ? ' · loose match' : ''}
          </span>
        )}
      </header>

      <SearchControls
        q={q}
        kind={kind ?? 'all'}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {failure ? (
          <p className="text-danger px-4 py-8 text-ui">{failure}</p>
        ) : query.length < 2 ? (
          <EmptyState
            title="Search subjects, todos and their notes at once."
            hint="Concluded and closed work is included on purpose — a recorded answer is the point."
          />
        ) : count === 0 ? (
          <EmptyState
            title={
              <>
                Nothing found for <span className="text-fg">{query}</span>.
              </>
            }
            hint="Nobody has looked into this yet — it could be a new subject."
          />
        ) : (
          <UnifiedResults rows={unified} query={query} />
        )}
      </div>
    </div>
  )
}

export default SearchPage

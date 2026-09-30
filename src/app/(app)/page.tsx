import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/data'
import { listStages, listSubjects, listTags } from '@/lib/lab/data'
import { LAB_VIEW_COOKIE, parseLabView } from '@/lib/lab/ui-view'
import { LabView } from '@/components/lab/lab-view'
import { LiveUpdates } from '@/components/live-updates'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Lab' }

/**
 * Home is the lab: every subject, filtered by the URL (`?tag=`, `?owner=me`,
 * `?q=`), shown as the list or the board this viewer last chose.
 */
const LabPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ tag?: string; owner?: string; q?: string }>
}) => {
  const user = await currentUser()
  if (!user) redirect('/login')

  const { tag = '', owner, q = '' } = await searchParams
  const mine = owner === 'me'

  const [stages, tags, subjects] = await Promise.all([
    listStages(),
    listTags(),
    listSubjects({
      ...(tag ? { tag } : {}),
      ...(mine ? { ownerId: user.id } : {}),
      ...(q.trim() ? { q: q.trim() } : {}),
    }),
  ])

  const initialView = parseLabView((await cookies()).get(LAB_VIEW_COOKIE)?.value)

  return (
    // page-scroll-guard: fills the viewport on purpose. LabView owns the
    // scrolling: the list scrolls as one, the board per lane. (h-dvh is set
    // on LabView's own root.)
    <div className="h-dvh">
      <LabView
        subjects={subjects}
        stages={stages}
        tags={tags}
        initialView={initialView}
        filters={{ tag, owner: mine ? 'me' : 'all', q }}
      />
      <LiveUpdates />
    </div>
  )
}

export default LabPage

import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/data'
import { listLabProjects, listStages, listSubjects, listTags } from '@/lib/lab/data'
import { LAB_VIEW_COOKIE, parseLabView } from '@/lib/lab/ui-view'
import { LabView } from '@/components/lab/lab-view'
import { LiveUpdates } from '@/components/live-updates'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Lab' }

/**
 * Home is the lab: every subject this viewer may see, filtered by the URL
 * (`?project=`, `?tag=`, `?owner=me`, `?private=1`, `?q=`), shown as the list
 * or the board this viewer last chose.
 */
const LabPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; tag?: string; owner?: string; private?: string; q?: string }>
}) => {
  const user = await currentUser()
  if (!user) redirect('/login')
  const viewer = { id: user.id, role: user.role }

  const { project = '', tag = '', owner, private: restricted, q = '' } = await searchParams
  const mine = owner === 'me'
  const onlyRestricted = restricted === '1'

  const [stages, tags, projects, listed] = await Promise.all([
    listStages(),
    listTags(),
    listLabProjects(viewer),
    listSubjects(
      {
        ...(project ? { project } : {}),
        ...(tag ? { tag } : {}),
        ...(mine ? { ownerId: user.id } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
      },
      viewer,
    ),
  ])
  // The server lists no one else's unpublished subject, so what is not `lab`
  // is the viewer's own or shared with them.
  const subjects = onlyRestricted ? listed.filter((s) => s.visibility !== 'lab') : listed

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
        projects={projects}
        initialView={initialView}
        filters={{ project, tag, owner: mine ? 'me' : 'all', restricted: onlyRestricted, q }}
      />
      <LiveUpdates />
    </div>
  )
}

export default LabPage

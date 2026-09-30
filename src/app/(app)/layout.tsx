import { redirect } from 'next/navigation'
import { currentUser, listProjects } from '@/lib/data'
import { listFormerKeys } from '@/lib/api/project-keys'
import { listPeople } from '@/lib/api/people'
import { CommandPalette } from '@/components/command-palette'
import { AppSidebar } from '@/components/app-sidebar'
import { TaskCreationProvider } from '@/components/task-creation'
import { SubjectCreationProvider } from '@/components/subject-creation'
import { listLabProjects, listStages, listTags } from '@/lib/lab/data'
import { TODO_PROJECT_KEY } from '@/lib/lab/types'
import { Shortcuts } from '@/components/shortcuts'
import { ProjectKeysProvider } from '@/components/project-keys'
import { PeopleProvider } from '@/components/people-context'
import { MobileNavProvider } from '@/components/mobile-nav-context'
import { ToastHost } from '@/components/toast'
import { LiveStatusIndicator, LiveStatusProvider } from '@/components/live-status'
import { loginRedirectTarget } from '@/lib/auth/login-redirect-server'

const AppLayout = async ({ children }: { children: React.ReactNode }) => {
  const user = await currentUser()
  // Middleware enforces this; a layout renders data and should not assume
  // the guard ran.
  if (!user) redirect(await loginRedirectTarget())

  const [projects, formerKeys, people, stages, tags, labProjects] = await Promise.all([
    listProjects(user.id),
    listFormerKeys(user.id),
    // Fetched once for every assignee and owner picker in the app, rather than
    // each one loading its own copy of the same short list.
    listPeople(),
    // For the new-subject dialog, which `c` opens from anywhere. A lab whose
    // tables are not there yet should still render the rest of the app.
    listStages().catch(() => []),
    listTags().catch(() => []),
    listLabProjects().catch(() => []),
  ])
  const email = user.email ?? 'you'
  const projectList = projects.map((p) => ({ key: p.key, title: p.title }))

  // Retired keys linkify too. A bare `ACME-42` in a task body or an agent's
  // note is matched by pattern against this list, so after a rename it still
  // looked like a ref, was still a link, and led nowhere — the memory store
  // breaking its own cross-references.
  // `T` always: the todos project is created lazily with the first todo, and a
  // write-up can mention T-1 before anyone has looked at it.
  const refKeys = [...new Set([TODO_PROJECT_KEY, ...projectList.map((p) => p.key), ...formerKeys.map((f) => f.key)])]

  return (
    <ToastHost>
      <LiveStatusProvider>
      <ProjectKeysProvider keys={refKeys}>
        <PeopleProvider people={people} currentUserId={user.id}>
        <TaskCreationProvider projects={projectList}>
        <SubjectCreationProvider stages={stages} tags={tags} projects={labProjects}>
          <MobileNavProvider email={email} role={user.role}>
            <div className="bg-bg flex h-dvh">
              <aside className="app-sidebar hidden w-[13.75rem] shrink-0 flex-col md:flex">
                <AppSidebar email={email} role={user.role} />
              </aside>

            <div className="app-canvas flex min-w-0 flex-1 flex-col">
              <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
            </div>
              <CommandPalette labProjects={labProjects} />
              <Shortcuts />
              {/* Fixed to the viewport, outside the scroll containers each
                  page owns, so it stays put wherever the reader is. */}
              <LiveStatusIndicator />
            </div>
          </MobileNavProvider>
        </SubjectCreationProvider>
        </TaskCreationProvider>
        </PeopleProvider>
      </ProjectKeysProvider>
      </LiveStatusProvider>
    </ToastHost>
  )
}

export default AppLayout

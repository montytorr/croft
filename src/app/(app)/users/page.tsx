import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { MobileNavButton } from '@/components/mobile-nav-context'
import { currentUser } from '@/lib/data'
import { listUsers } from '@/lib/api/users'
import { mailConfigured } from '@/lib/mail'
import { UsersManager } from './users-manager'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Users' }

const UsersPage = async () => {
  const user = await currentUser()
  if (!user) redirect('/login')
  if (user.role !== 'admin') redirect('/')

  const users = await listUsers()

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-8 md:py-8">
        <header className="mb-8 flex items-start gap-2">
          <span className="-ml-1.5 md:hidden"><MobileNavButton /></span>
          <div>
            <h1 className="font-display headline text-2xl leading-none">Users</h1>
            <p className="text-fg-subtle mt-2 max-w-2xl text-[0.75rem] leading-relaxed">
              Manage workspace access, roles, password resets, and each user&apos;s agent identities.
              Disabling a user revokes their browser sessions and active agent keys immediately, and
              hands their open tasks to someone you choose. A password is never set from here: a reset
              sends the person a single-use link, and only they choose what it becomes.
            </p>
          </div>
        </header>
        <UsersManager users={users} currentUserId={user.id} mailReady={mailConfigured()} />
      </div>
    </div>
  )
}

export default UsersPage

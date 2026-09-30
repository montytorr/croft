import Link from 'next/link'
import { BrandMark, BrandName } from '@/components/brand'
import { ThemeToggle } from '@/components/theme-toggle'
import { AppNav, type NavProject } from '@/components/app-nav'
import { UserMenu } from '@/components/user-menu'

/**
 * One sidebar, two homes: the fixed rail on a wide screen and the drawer on a
 * narrow one. Extracted so the two cannot drift — a phone showing different
 * navigation from the desktop is worse than no phone support.
 */
export const AppSidebar = ({
  email,
  role,
  projects = [],
  onNavigate,
  trailing,
}: {
  email: string
  role: 'admin' | 'member'
  /** The lab's projects, listed under the places with their subject counts. */
  projects?: NavProject[]
  /** Closes the drawer after a tap. Absent on the desktop rail. */
  onNavigate?: () => void
  /**
   * Rendered at the end of the header row. The drawer's close button used to
   * be positioned absolutely over this row, landing exactly on top of the
   * theme toggle. Laying it out here means the two cannot collide again
   * whatever either one's size becomes.
   */
  trailing?: React.ReactNode
}) => (
  <>
    <div className="flex h-[2.75rem] shrink-0 items-center gap-2 px-3">
      {/* The instance, not the person: who is signed in is the menu at the
          foot of this column, and two Crofts open side by side have to be
          told apart at a glance. */}
      <Link
        href="/"
        onClick={onNavigate}
        className="text-fg flex min-w-0 items-center gap-2 text-[0.8125rem] font-semibold tracking-tight"
      >
        <BrandMark size={20} className="rounded-[5px]" />
        <span className="truncate">
          <BrandName />
        </span>
      </Link>
      <span className="ml-auto flex items-center gap-0.5">
        <ThemeToggle />
        {trailing}
      </span>
    </div>

    <AppNav onNavigate={onNavigate} projects={projects} canManageProjects={role === 'admin'} />

    <UserMenu email={email} role={role} onNavigate={onNavigate} />
  </>
)

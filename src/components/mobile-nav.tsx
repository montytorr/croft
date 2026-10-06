'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { AppSidebar } from '@/components/app-sidebar'
import type { NavProject } from '@/components/app-nav'

/**
 * The whole of navigation on a narrow screen. Until this existed the sidebar
 * was simply `hidden md:flex`, which left a phone with no way to reach any
 * other page at all.
 */
export const MobileNav = ({
  email,
  role,
  projects,
}: {
  email: string
  role: 'admin' | 'member'
  projects: NavProject[]
}) => {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // Escape closes it, and the body must not scroll behind an open drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="text-fg-muted hover:text-fg hover:bg-surface-hover grid size-11 shrink-0 place-items-center rounded-md transition-colors md:hidden"
      >
        <Menu size={16} aria-hidden />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="scrim absolute inset-0"
            onClick={() => setOpen(false)}
            role="presentation"
          />
          <aside
            className="app-sidebar enter-sheet relative flex w-[16.875rem] max-w-[82vw] flex-col"
            /* Keyed on the path so a navigation rebuilds it collapsed, rather
               than leaving a filter box half-typed from the last visit. */
            key={pathname}
          >
            <AppSidebar
              email={email}
              role={role}
              projects={projects}
              onNavigate={() => setOpen(false)}
              trailing={
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                  className="text-fg-subtle hover:text-fg hover:bg-surface-raised grid size-6 place-items-center rounded transition-colors"
                >
                  <X size={14} aria-hidden />
                </button>
              }
            />
          </aside>
        </div>
      )}
    </>
  )
}

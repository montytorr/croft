'use client'

import { createContext, useContext, useMemo } from 'react'
import { MobileNav } from '@/components/mobile-nav'
import type { NavProject } from '@/components/app-nav'

/**
 * The hamburger belongs in each page's own header bar, not floating over the
 * content — but the layout is where the viewer is known. This carries that
 * down so any page header can drop the button into place.
 */
const MobileNavContext = createContext<{
  email: string
  role: 'admin' | 'member'
  projects: NavProject[]
} | null>(null)

export const MobileNavProvider = ({
  email,
  role,
  projects = [],
  children,
}: {
  email: string
  role: 'admin' | 'member'
  projects?: NavProject[]
  children: React.ReactNode
}) => {
  const value = useMemo(() => ({ email, role, projects }), [email, role, projects])
  return <MobileNavContext.Provider value={value}>{children}</MobileNavContext.Provider>
}

/** Renders nothing on desktop; the hamburger on narrow screens. */
export const MobileNavButton = () => {
  const ctx = useContext(MobileNavContext)
  if (!ctx) return null
  return <MobileNav email={ctx.email} role={ctx.role} projects={ctx.projects} />
}

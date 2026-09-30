'use client'

import { createContext, useContext } from 'react'
import { cn } from '@/lib/utils'

/**
 * What this instance is called, from the root layout down to anything that
 * names it. Two Crofts open side by side — a personal one and a work one —
 * were two identical tabs and two identical sidebars.
 */
export type Brand = { name: string }

const BrandContext = createContext<Brand>({ name: 'Croft' })

export const BrandProvider = ({ brand, children }: { brand: Brand; children: React.ReactNode }) => (
  <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
)

export const useBrand = () => useContext(BrandContext)

/**
 * The mark: three stones on the dark tile, exactly as the favicon draws them.
 * The stones take --brand-mark, which the instance's accent sets, so each
 * Croft's mark is the same croft in its own colour.
 */
export const BrandMark = ({ size = 20, className }: { size?: number; className?: string }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden className={cn('shrink-0', className)}>
    <rect width="32" height="32" rx="7" fill="#08090a" />
    <g fill="var(--brand-mark)">
      <rect x="10" y="5.75" width="12" height="5.5" rx="2.75" />
      <rect x="6" y="13.25" width="20" height="5.5" rx="2.75" />
      <rect x="9" y="20.75" width="14" height="5.5" rx="2.75" />
    </g>
  </svg>
)

/** The instance's name as text, for the root of each page's breadcrumb. */
export const BrandName = () => <>{useBrand().name}</>

'use client'

import { createContext, useContext } from 'react'
import { cn } from '@/lib/utils'
import { MARK_TILE, RIG_PATHS } from '@/lib/brand-mark'

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
 * The mark: three rig strips cut from the peat tile, exactly as the favicon
 * draws them. The strips take --brand-mark, which the instance's accent sets,
 * so each Croft's mark is the same field in its own colour. `colour` pins it
 * instead — the branding preview draws a mark that is not saved yet.
 */
export const BrandMark = ({
  size = 20,
  className,
  colour = 'var(--brand-mark)',
}: {
  size?: number
  className?: string
  colour?: string
}) => (
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden className={cn('shrink-0', className)}>
    <rect width="32" height="32" rx="7" fill={MARK_TILE} />
    <g fill={colour} stroke={colour} strokeWidth="0.8" strokeLinejoin="round">
      {RIG_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  </svg>
)

/** The instance's name as text, for the root of each page's breadcrumb. */
export const BrandName = () => <>{useBrand().name}</>

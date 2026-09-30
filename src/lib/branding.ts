import { admin } from '@/lib/db/client'
import { HEX, paletteFor, type Palette } from '@/lib/brand-colour'

export const DEFAULT_NAME = 'Croft'

export type Branding = {
  /** What this instance calls itself: the sidebar, the tab titles, the login page. */
  name: string
  /** The accent as the admin chose it; null keeps the stock indigo. */
  accent: string | null
  palette: Palette | null
  /**
   * Changes whenever the branding does. The icon URLs carry it, so a browser
   * holding yesterday's favicon asks again instead of keeping it.
   */
  version: string
}

export const STOCK: Branding = {
  name: DEFAULT_NAME,
  accent: null,
  palette: null,
  version: '0',
}

type Row = { name: string | null; accent: string | null; updated_at: string | Date }

export const brandingFrom = (row: Row | null): Branding => {
  if (!row) return STOCK
  const accent = row.accent && HEX.test(row.accent) ? row.accent.toLowerCase() : null
  return {
    name: row.name?.trim() || DEFAULT_NAME,
    accent,
    palette: accent ? paletteFor(accent) : null,
    version: String(new Date(row.updated_at).getTime()),
  }
}

/**
 * Every page render reads this, the login page included, so it is held in the
 * process for a short while rather than queried each time. Short, because the
 * service can run more than one instance and only the one that took the save
 * can drop its copy: the others catch up within the TTL.
 *
 * On globalThis rather than in a module variable: Next may bundle this file
 * once for route handlers and again for pages, and a module-level copy would
 * leave the save route clearing a memo the pages never read.
 */
const TTL_MS = 30_000
const MEMO = Symbol.for('croft.branding')
type Memo = { at: number; value: Promise<Branding> }
const store = globalThis as typeof globalThis & { [MEMO]?: Memo }

const read = async (): Promise<Branding> => {
  const { data, error } = await admin()
    .from('instance_branding')
    .select('name, accent, updated_at')
    .maybeSingle<Row>()
  // Branding is decoration. A database that has not run 066 yet, or a query
  // that fails, gets the stock look rather than a page that will not render.
  if (error) return STOCK
  return brandingFrom(data)
}

export const getBranding = (): Promise<Branding> => {
  const hit = store[MEMO]
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = read().catch(() => STOCK)
  store[MEMO] = { at: Date.now(), value }
  return value
}

export const invalidateBranding = () => {
  delete store[MEMO]
}

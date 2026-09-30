/**
 * The mark: three rig strips — curved field strips running up a hill — cut
 * out of a dark heather-peat tile. One geometry for the sidebar, the favicon,
 * the home-screen icon and the social card.
 *
 * Solid strips rather than outlines, with furrows wide enough (about 2.8 units
 * at the foot) to survive a 16px tab: narrower ones closed up into a single
 * blob at that size. The strips take the instance's accent; the tile does not
 * change, so every Croft is the same field in its own colour.
 */

/** The peat tile, the same in both themes (--brand-tile in globals.css). */
export const MARK_TILE = '#2e1d2a'

/** The three strips in a 32-unit box, foot at y=26, brow at y=6. */
export const RIG_PATHS = [
  'M5 26C5.31 19.4 14.11 12.8 13.5 6L15.83 6C17.4 12.8 9.51 19.4 10.13 26Z',
  'M12.93 26C12.05 19.4 19.67 12.8 17.83 6L20.17 6C22.95 12.8 16.26 19.4 18.07 26Z',
  'M20.87 26C18.8 19.4 25.22 12.8 22.17 6L24.5 6C28.51 12.8 23.01 19.4 26 26Z',
] as const

/**
 * The mark as an SVG document. `rounded: false` draws the tile full-bleed, for
 * the iOS home-screen icon, which the system masks to its own corner shape.
 */
export const rigsSvg = (strip: string, { rounded = true }: { rounded?: boolean } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32"${rounded ? ' rx="7"' : ''} fill="${MARK_TILE}"/>` +
  `<g fill="${strip}" stroke="${strip}" stroke-width="0.8" stroke-linejoin="round">` +
  RIG_PATHS.map((d) => `<path d="${d}"/>`).join('') +
  `</g></svg>`

/** The same document as a data URI, for next/og, which draws <img> but not inline SVG paths reliably. */
export const rigsDataUri = (strip: string, options?: { rounded?: boolean }) =>
  `data:image/svg+xml;base64,${Buffer.from(rigsSvg(strip, options)).toString('base64')}`

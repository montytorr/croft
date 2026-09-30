/**
 * Starting colours for the lab's curated lists — stages, tags, projects. Mid-tones
 * that hold up on paper and on peat alike, none of them heather, which is the
 * accent's alone.
 */
export const LAB_PRESETS = [
  '#5a6f8c', '#8a4f1c', '#4a7a2c', '#7d5d50', '#2f7a6e', '#5b4bb0', '#2f62a8', '#a14a22', '#b08a2e', '#6f666b',
] as const

/** The preset after the ones already used, so a new entry does not repeat the last one's colour. */
export const nextPreset = (used: number): string => LAB_PRESETS[used % LAB_PRESETS.length]!

export const CAIRN_KEY = /^[A-Z][A-Z0-9]{1,9}$/

/** A typed Cairn key, cleaned: trimmed, upper-cased; empty reads as none. */
export const normaliseCairnKey = (raw: string): string | null => {
  const key = raw.trim().toUpperCase()
  return key ? key : null
}

/**
 * A lab-project filter from the URL, matched to a project: by name (any case),
 * by id, or `none` for subjects without one. Unknown values match nothing.
 */
export const matchProjectFilter = <P extends { id: string; name: string }>(
  value: string | null | undefined,
  projects: P[],
): P | 'none' | null => {
  const v = value?.trim()
  if (!v) return null
  if (v.toLowerCase() === 'none') return 'none'
  const lower = v.toLowerCase()
  return projects.find((p) => p.id === v || p.name.toLowerCase() === lower) ?? null
}

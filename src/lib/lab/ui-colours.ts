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

/** A tracker's name and a target inside it, as the API accepts them. */
export const HANDOFF_TRACKER = /^[a-z][a-z0-9-]{1,31}$/
export const HANDOFF_TARGET = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/

/** Trackers worth suggesting; the field takes any name. */
export const HANDOFF_TRACKER_SUGGESTIONS = ['cairn', 'github'] as const

/** A typed tracker name, cleaned: trimmed, lower-cased; empty reads as none. */
export const normaliseHandoffTracker = (raw: string): string | null => {
  const name = raw.trim().toLowerCase()
  return name ? name : null
}

/** A typed target, trimmed (its case is the tracker's to care about); empty reads as none. */
export const normaliseHandoffTarget = (raw: string): string | null => {
  const target = raw.trim()
  return target ? target : null
}

export type HandoffDraft =
  | { ok: true; tracker: string | null; target: string | null }
  | { ok: false; error: string }

/** A typed hand-off, checked: both or neither (neither clears it), each in the shape the API takes. */
export const parseHandoffDraft = (trackerRaw: string, targetRaw: string): HandoffDraft => {
  const tracker = normaliseHandoffTracker(trackerRaw)
  const target = normaliseHandoffTarget(targetRaw)
  if (!tracker && !target) return { ok: true, tracker: null, target: null }
  if (!tracker || !target) return { ok: false, error: 'Give a tracker and a target, or leave both empty.' }
  if (!HANDOFF_TRACKER.test(tracker)) return { ok: false, error: 'A tracker is lower-case letters, digits and dashes.' }
  if (!HANDOFF_TARGET.test(target)) return { ok: false, error: 'A target is letters, digits and . _ / - only.' }
  return { ok: true, tracker, target }
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

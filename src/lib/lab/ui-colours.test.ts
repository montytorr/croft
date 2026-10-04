import { describe, expect, it } from 'vitest'
import {
  HANDOFF_TARGET, HANDOFF_TRACKER, LAB_PRESETS, matchProjectFilter, nextPreset, normaliseHandoffTarget, normaliseHandoffTracker,
  parseHandoffDraft,
} from './ui-colours'

const projects = [
  { id: 'p1', name: 'Trig' },
  { id: 'p2', name: 'Croft' },
]

describe('the lab project filter from the URL', () => {
  it('matches a project by name in any case, or by id', () => {
    expect(matchProjectFilter('trig', projects)).toEqual(projects[0])
    expect(matchProjectFilter(' CROFT ', projects)).toEqual(projects[1])
    expect(matchProjectFilter('p2', projects)).toEqual(projects[1])
  })

  it('reads none as the subjects without a project', () => {
    expect(matchProjectFilter('none', projects)).toBe('none')
    expect(matchProjectFilter('None', projects)).toBe('none')
  })

  it('matches nothing for an empty or unknown value', () => {
    expect(matchProjectFilter('', projects)).toBeNull()
    expect(matchProjectFilter(undefined, projects)).toBeNull()
    expect(matchProjectFilter('dispofi', projects)).toBeNull()
  })
})

describe('a typed hand-off', () => {
  it('lower-cases the tracker, keeps the target as typed, and reads empty as none', () => {
    expect(normaliseHandoffTracker(' GitHub ')).toBe('github')
    expect(normaliseHandoffTracker('   ')).toBeNull()
    expect(normaliseHandoffTarget(' Owner/Repo ')).toBe('Owner/Repo')
    expect(normaliseHandoffTarget('')).toBeNull()
  })

  it('is checked against the same shapes the API enforces', () => {
    expect(HANDOFF_TRACKER.test('cairn')).toBe(true)
    expect(HANDOFF_TRACKER.test('a')).toBe(false)
    expect(HANDOFF_TRACKER.test('2fa')).toBe(false)
    expect(HANDOFF_TARGET.test('CAIRN')).toBe(true)
    expect(HANDOFF_TARGET.test('owner/repo.js')).toBe(true)
    expect(HANDOFF_TARGET.test('/repo')).toBe(false)
    expect(HANDOFF_TARGET.test('two words')).toBe(false)
  })

  it('needs both or neither, and neither clears it', () => {
    expect(parseHandoffDraft('Cairn', ' TRIG ')).toEqual({ ok: true, tracker: 'cairn', target: 'TRIG' })
    expect(parseHandoffDraft('', '  ')).toEqual({ ok: true, tracker: null, target: null })
    expect(parseHandoffDraft('github', '').ok).toBe(false)
    expect(parseHandoffDraft('', 'owner/repo').ok).toBe(false)
    expect(parseHandoffDraft('git hub', 'owner/repo').ok).toBe(false)
    expect(parseHandoffDraft('github', 'two words').ok).toBe(false)
  })
})

describe('preset colours', () => {
  it('cycle, and never use the heather accent', () => {
    expect(nextPreset(0)).toBe(LAB_PRESETS[0])
    expect(nextPreset(LAB_PRESETS.length + 1)).toBe(LAB_PRESETS[1])
    expect(LAB_PRESETS).not.toContain('#8e3f73')
  })
})

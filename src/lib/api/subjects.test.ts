import { describe, expect, it } from 'vitest'
import { conclusionMissing, nextConcludedAt, noteContentHash, stageNoteHash, stageNoteText } from './subjects'
import {
  cairnOutcomeHash,
  cairnOutcomeNote,
  closedInCairnKind,
  closedInCairnResolution,
} from './cairn-link'
import { parseRef } from './tasks'
import { parseSubjectRef, subjectRef, isConcluding } from '@/lib/lab/types'
import { PROJECT_KEY_RULE } from '@/lib/project-rename'

describe('subject refs', () => {
  it('reads S-12, s-12 and a bare number', () => {
    expect(parseSubjectRef('S-12')).toBe(12)
    expect(parseSubjectRef('s-12')).toBe(12)
    expect(parseSubjectRef(' 12 ')).toBe(12)
    expect(subjectRef(12)).toBe('S-12')
  })

  it('refuses anything that is not a subject ref', () => {
    for (const bad of ['T-12', 'S-', 'S12', 'CAIRN-12', '', 'S-1.5']) expect(parseSubjectRef(bad)).toBeNull()
  })
})

describe('single-letter project keys', () => {
  it('are valid keys, so the todo project can be T', () => {
    expect(PROJECT_KEY_RULE.test('T')).toBe(true)
    expect(PROJECT_KEY_RULE.test('CAI')).toBe(true)
    expect(PROJECT_KEY_RULE.test('1A')).toBe(false)
    expect(PROJECT_KEY_RULE.test('ABCDEFGHIJK')).toBe(false)
  })

  it('make T-41 an addressable task ref', () => {
    expect(parseRef('T-41')).toEqual({ key: 'T', number: 41 })
    expect(parseRef('t-41')).toEqual({ key: 'T', number: 41 })
  })

  it('stay invisible to Cairn, whose refs need a key of two or more', () => {
    const CAIRN_REF = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/
    expect(CAIRN_REF.test('T-41')).toBe(false)
    expect(CAIRN_REF.test('S-12')).toBe(false)
  })
})

describe('the conclusion rule', () => {
  const base = { stageChanging: true, conclusionTouched: false, conclusion: null }

  it('requires a conclusion to enter a completed or dropped stage', () => {
    expect(conclusionMissing({ ...base, targetCategory: 'completed' })).toBe(true)
    expect(conclusionMissing({ ...base, targetCategory: 'dropped' })).toBe(true)
    expect(conclusionMissing({ ...base, targetCategory: 'dropped', conclusion: '   ' })).toBe(true)
  })

  it('is satisfied by a conclusion already recorded or sent with the move', () => {
    expect(conclusionMissing({ ...base, targetCategory: 'completed', conclusion: 'It works.' })).toBe(false)
  })

  it('never applies to planned or active stages', () => {
    expect(conclusionMissing({ ...base, targetCategory: 'planned' })).toBe(false)
    expect(conclusionMissing({ ...base, targetCategory: 'active' })).toBe(false)
  })

  it('refuses clearing the conclusion of a concluded subject', () => {
    expect(
      conclusionMissing({ stageChanging: false, conclusionTouched: true, targetCategory: 'completed', conclusion: null }),
    ).toBe(true)
  })

  it('does not block unrelated edits to a subject that is already sitting in a concluding stage', () => {
    expect(
      conclusionMissing({ stageChanging: false, conclusionTouched: false, targetCategory: 'completed', conclusion: null }),
    ).toBe(false)
  })

  it('agrees with isConcluding', () => {
    expect(isConcluding('completed')).toBe(true)
    expect(isConcluding('active')).toBe(false)
  })
})

describe('concluded_at', () => {
  const now = '2026-09-30T10:00:00.000Z'
  it('is stamped on the way in and cleared on the way out', () => {
    expect(nextConcludedAt({ fromCategory: 'active', toCategory: 'completed', concludedAt: null, now })).toBe(now)
    expect(nextConcludedAt({ fromCategory: 'completed', toCategory: 'active', concludedAt: now, now })).toBeNull()
  })

  it('keeps the original moment when moving between concluding stages', () => {
    const earlier = '2026-01-01T00:00:00.000Z'
    expect(nextConcludedAt({ fromCategory: 'completed', toCategory: 'dropped', concludedAt: earlier, now })).toBe(earlier)
  })
})

describe('notes', () => {
  it('writes stage moves as "from → to"', () => {
    expect(stageNoteText('to explore', 'exploring')).toBe('to explore → exploring')
  })

  it('dedupes a written note on kind and text', () => {
    expect(noteContentHash('note', 'x')).toBe(noteContentHash('note', 'x'))
    expect(noteContentHash('note', 'x')).not.toBe(noteContentHash('finding', 'x'))
  })

  it('never dedupes two moves along the same path', () => {
    expect(stageNoteHash('a', 'b', '2026-09-30T10:00:00.000Z')).not.toBe(stageNoteHash('a', 'b', '2026-09-30T10:00:01.000Z'))
  })
})

describe('cairn', () => {
  it('writes the outcome line with the resolution when there is one', () => {
    expect(cairnOutcomeNote('CAIRN-331', 'done', ' Shipped in v2. ')).toBe('CAIRN-331 done: Shipped in v2.')
    expect(cairnOutcomeNote('CAIRN-331', 'cancelled', null)).toBe('CAIRN-331 cancelled')
  })

  it('keys the outcome on ref and status, so a revised resolution is not a second note', () => {
    expect(cairnOutcomeHash('CAIRN-331', 'done')).toBe(cairnOutcomeHash('CAIRN-331', 'done'))
    expect(cairnOutcomeHash('CAIRN-331', 'done')).not.toBe(cairnOutcomeHash('CAIRN-331', 'cancelled'))
  })

  it('closes a todo saying where it was closed, with Cairn\'s kind or `verified`', () => {
    expect(closedInCairnResolution('CAIRN-331', ' Shipped in v2. ')).toBe('Closed in Cairn as CAIRN-331: Shipped in v2.')
    expect(closedInCairnResolution('CAIRN-331', null)).toBe('Closed in Cairn as CAIRN-331')
    expect(closedInCairnKind('wont-fix')).toBe('wont-fix')
    // A kind Croft does not have, or none, must not fail the close.
    expect(closedInCairnKind('shipped')).toBe('verified')
    expect(closedInCairnKind(null)).toBe('verified')
  })


})

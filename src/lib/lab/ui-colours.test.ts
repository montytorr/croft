import { describe, expect, it } from 'vitest'
import { CAIRN_KEY, LAB_PRESETS, matchProjectFilter, nextPreset, normaliseCairnKey } from './ui-colours'

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

describe('a typed Cairn key', () => {
  it('is trimmed and upper-cased, and empty means none', () => {
    expect(normaliseCairnKey(' trig ')).toBe('TRIG')
    expect(normaliseCairnKey('   ')).toBeNull()
  })

  it('is checked against the same shape the API enforces', () => {
    expect(CAIRN_KEY.test('TRIG')).toBe(true)
    expect(CAIRN_KEY.test('C2')).toBe(true)
    expect(CAIRN_KEY.test('T')).toBe(false)
    expect(CAIRN_KEY.test('2C')).toBe(false)
    expect(CAIRN_KEY.test('ABCDEFGHIJK')).toBe(false)
  })
})

describe('preset colours', () => {
  it('cycle, and never use the heather accent', () => {
    expect(nextPreset(0)).toBe(LAB_PRESETS[0])
    expect(nextPreset(LAB_PRESETS.length + 1)).toBe(LAB_PRESETS[1])
    expect(LAB_PRESETS).not.toContain('#8e3f73')
  })
})

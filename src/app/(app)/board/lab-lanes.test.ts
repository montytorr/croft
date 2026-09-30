import { describe, expect, it } from 'vitest'
import { buildBoardUrl, parseFilters } from '@/lib/board-state'
import {
  EMPTY_LAB_VIEW,
  NO_LANE,
  labLaneValue,
  labLanesFor,
  matchesLabView,
  parseLabView,
  withLabParams,
} from './lab-lanes'

const croft = { name: 'Croft', color: '#5a6f8c' }
const trig = { name: 'Trig', color: '#8a4f1c' }
const subject = (number: number, project: { name: string; color: string } | null = null) => ({
  ref: `S-${number}`,
  number,
  title: `subject ${number}`,
  project,
})

describe('the lab params on a board link', () => {
  it('reads lab projects, subjects and a lab lane', () => {
    expect(parseLabView('')).toEqual(EMPTY_LAB_VIEW)
    expect(parseLabView('labProject=Croft,none&subject=S-2&swimlane=subject')).toEqual({
      labProjects: ['Croft', 'none'],
      subjects: ['S-2'],
      lane: 'subject',
    })
    expect(parseLabView('subject=s-2,7,none').subjects).toEqual(['S-2', 'S-7', 'none'])
    // The board's own lanes are not lab lanes.
    expect(parseLabView('swimlane=priority').lane).toBeNull()
  })

  it('survives the board rebuilding its URL, which knows only its own params', () => {
    const search = '?groupBy=priority&labProject=Croft&subject=S-2&swimlane=subject&closed=1'
    const board = parseFilters(search)
    // The board reads a lab lane as no lane…
    expect(board.swimlane).toBe('none')
    const url = withLabParams(buildBoardUrl('/board', board, search), parseLabView(search))
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('groupBy')).toBe('priority')
    expect(params.get('closed')).toBe('1')
    expect(params.get('labProject')).toBe('Croft')
    expect(params.get('subject')).toBe('S-2')
    // …and the lab puts it back.
    expect(params.get('swimlane')).toBe('subject')
  })

  it('leaves a plain board link plain', () => {
    expect(withLabParams('/board', EMPTY_LAB_VIEW)).toBe('/board')
  })
})

describe('filtering cards by the lab', () => {
  const a = { subject: subject(1, croft) }
  const b = { subject: subject(2, trig) }
  const c = { subject: subject(3) }
  const d = { subject: null }
  const pick = (view: Partial<typeof EMPTY_LAB_VIEW>) =>
    [a, b, c, d].filter((t) => matchesLabView(t, { ...EMPTY_LAB_VIEW, ...view }))

  it('by lab project in any case, several at once, or none', () => {
    expect(pick({ labProjects: ['croft'] })).toEqual([a])
    expect(pick({ labProjects: ['Croft', 'Trig'] })).toEqual([a, b])
    expect(pick({ labProjects: ['none'] })).toEqual([c, d])
  })

  it('by subject, or none', () => {
    expect(pick({ subjects: ['S-2', '3'] })).toEqual([b, c])
    expect(pick({ subjects: ['none'] })).toEqual([d])
  })
})

describe('lanes by subject and by lab project', () => {
  const cards = [
    { subject: null },
    { subject: subject(4) },
    { subject: subject(2, trig) },
    { subject: subject(1, croft) },
    { subject: subject(7, croft) },
    { subject: subject(7, croft) },
  ]

  it('one lane per subject: projects by name, newest subject first, no subject last', () => {
    const lanes = labLanesFor('subject', cards)
    expect(lanes.map((l) => l.value)).toEqual(['S-7', 'S-1', 'S-2', 'S-4', NO_LANE])
    expect(lanes[0]).toMatchObject({ ref: 'S-7', href: '/subjects/7', color: croft.color, label: 'subject 7' })
    expect(lanes.at(-1)!.label).toBe('No subject')
  })

  it('one lane per lab project, no project last', () => {
    expect(labLanesFor('labProject', cards).map((l) => l.label)).toEqual(['Croft', 'Trig', 'No project'])
  })

  it('puts each card in its lane', () => {
    expect(labLaneValue({ subject: subject(7, croft) }, 'subject')).toBe('S-7')
    expect(labLaneValue({ subject: subject(7, croft) }, 'labProject')).toBe('Croft')
    expect(labLaneValue({ subject: subject(4) }, 'labProject')).toBe(NO_LANE)
    expect(labLaneValue({ subject: null }, 'subject')).toBe(NO_LANE)
  })
})

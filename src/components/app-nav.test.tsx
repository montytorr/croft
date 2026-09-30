import { describe, expect, it } from 'vitest'
import { activeProjectFor, navEntryFor, projectHref } from './app-nav'

describe('which sidebar entry is lit', () => {
  it('keeps the lab lit on a subject', () => {
    expect(navEntryFor('/')).toBe('/')
    expect(navEntryFor('/subjects/12')).toBe('/')
  })

  it('lights todos on a todo, which lives under its internal project', () => {
    expect(navEntryFor('/projects/T/tasks/4')).toBe('/todos')
  })

  it('lights the entry itself', () => {
    expect(navEntryFor('/todos')).toBe('/todos')
    expect(navEntryFor('/board')).toBe('/board')
    expect(navEntryFor('/activity')).toBe('/activity')
  })

  it('lights nothing elsewhere', () => {
    expect(navEntryFor('/settings')).toBeNull()
    expect(navEntryFor('/projects/T')).toBeNull()
  })
})

describe('which lab project is lit', () => {
  const projects = [
    { id: 'p1', name: 'Croft' },
    { id: 'p2', name: 'Trig Point' },
  ]

  it('lights the project the lab is filtered to, by name in any case or by id', () => {
    expect(activeProjectFor('/', 'Croft', projects)).toBe('p1')
    expect(activeProjectFor('/', 'trig point', projects)).toBe('p2')
    expect(activeProjectFor('/', 'p2', projects)).toBe('p2')
  })

  it('lights nothing for no filter, "none", or a project that does not exist', () => {
    expect(activeProjectFor('/', null, projects)).toBeNull()
    expect(activeProjectFor('/', 'none', projects)).toBeNull()
    expect(activeProjectFor('/', 'nope', projects)).toBeNull()
  })

  it('only on the lab itself: a subject page or /todos carrying ?project= is not the filtered lab', () => {
    expect(activeProjectFor('/subjects/3', 'Croft', projects)).toBeNull()
    expect(activeProjectFor('/todos', 'Croft', projects)).toBeNull()
  })

  it('links to the lab filtered to the project, encoded', () => {
    expect(projectHref('Trig Point')).toBe('/?project=Trig%20Point')
    expect(projectHref('R&D')).toBe('/?project=R%26D')
  })
})

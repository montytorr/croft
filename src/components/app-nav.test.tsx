import { describe, expect, it } from 'vitest'
import { navEntryFor } from './app-nav'

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

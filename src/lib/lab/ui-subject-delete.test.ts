import { describe, expect, it } from 'vitest'
import { canDeleteSubject } from './ui-subject-delete'

const owner = { id: 'u-cal', name: 'Cal' }
const cal = { userId: 'u-cal', role: 'member' }
const mael = { userId: 'u-mael', role: 'member' }
const admin = { userId: 'u-admin', role: 'admin' }

describe('who can delete a subject', () => {
  it('lets the owner, whatever the visibility', () => {
    for (const visibility of ['private', 'members', 'lab'] as const) {
      expect(canDeleteSubject({ owner, visibility }, cal)).toBe(true)
    }
  })

  it('lets an administrator delete a lab subject only', () => {
    expect(canDeleteSubject({ owner, visibility: 'lab' }, admin)).toBe(true)
    expect(canDeleteSubject({ owner, visibility: 'members' }, admin)).toBe(false)
    expect(canDeleteSubject({ owner, visibility: 'private' }, admin)).toBe(false)
  })

  it('refuses anyone else', () => {
    expect(canDeleteSubject({ owner, visibility: 'lab' }, mael)).toBe(false)
  })

  it('leaves an ownerless subject to administrators, in the lab', () => {
    expect(canDeleteSubject({ owner: null, visibility: 'lab' }, mael)).toBe(false)
    expect(canDeleteSubject({ owner: null, visibility: 'lab' }, admin)).toBe(true)
    expect(canDeleteSubject({ owner: null, visibility: 'private' }, admin)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { handoffOf, isHandedOff, refuseHandedOff, withHandoff } from './handoff-shape'

const linked = {
  handoff_tracker: 'github',
  handoff_ref: 'owner/repo#4',
  handoff_url: 'https://github.com/owner/repo/issues/4',
  handoff_status: 'todo',
  handoff_synced_at: '2026-01-01T00:00:00Z',
}

describe('handoffOf', () => {
  it('reads the columns as one object, or null without a tracker and a ref', () => {
    expect(handoffOf(linked)).toEqual({
      tracker: 'github',
      ref: 'owner/repo#4',
      url: 'https://github.com/owner/repo/issues/4',
      status: 'todo',
      synced_at: '2026-01-01T00:00:00Z',
    })
    expect(handoffOf({ handoff_ref: null, handoff_tracker: null })).toBeNull()
    expect(handoffOf(null)).toBeNull()
  })
})

describe('withHandoff', () => {
  it('replaces the columns with `handoff` and keeps the cairn aliases null for another tracker', () => {
    const shaped = withHandoff({ id: 't', ...linked }) as Record<string, unknown>
    expect(shaped).not.toHaveProperty('handoff_ref')
    expect(shaped).toMatchObject({ id: 't', cairn_ref: null, cairn_status: null, cairn_synced_at: null })
    expect((shaped.handoff as { tracker: string }).tracker).toBe('github')
  })

  it('fills the deprecated aliases when the tracker is cairn', () => {
    const shaped = withHandoff({ id: 't', ...linked, handoff_tracker: 'cairn', handoff_ref: 'CAIRN-331', handoff_status: 'doing' })
    expect(shaped).toMatchObject({ cairn_ref: 'CAIRN-331', cairn_status: 'doing' })
  })

  it('says handoff: null on a row selected with the columns but not linked, and leaves other rows alone', () => {
    expect(withHandoff({ id: 't', handoff_ref: null, handoff_tracker: null })).toMatchObject({ handoff: null, cairn_ref: null })
    expect(withHandoff({ id: 't' })).toEqual({ id: 't' })
  })
})

describe('refuseHandedOff', () => {
  it('holds while the tracker has not ended the task', () => {
    for (const handoff_status of [null, 'todo', 'doing']) {
      expect(isHandedOff({ ...linked, handoff_status }), String(handoff_status)).toBe(true)
      expect(refuseHandedOff({ ...linked, handoff_status }, 'T-41')?.status).toBe(409)
    }
  })

  it('lets go once the outcome is in, and for a todo that was never handed off', () => {
    for (const handoff_status of ['done', 'cancelled']) expect(refuseHandedOff({ ...linked, handoff_status }, 'T-41')).toBeNull()
    expect(refuseHandedOff({ handoff_ref: null, handoff_tracker: null }, 'T-41')).toBeNull()
  })

  it('names the todo, the tracker, the ref and the way out', async () => {
    const body = await refuseHandedOff(linked, 'T-41')!.json()
    expect(body.code).toBe('handed_off')
    expect(body.error).toBe(
      'T-41 was handed off to github as owner/repo#4, which owns its status now: work it there ' +
        '(croft sync brings the outcome back), or take it back: croft handoff T-41 --undo',
    )
  })
})

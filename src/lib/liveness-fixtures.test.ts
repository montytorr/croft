import { describe, expect, it } from 'vitest'
import { CLAIM_EVIDENCE_EVENTS, lastSignOfLife } from './api/reconcile'
import { HOLDER, LIVENESS_CASES, type EvidenceEvent } from './liveness-fixtures'

const NOW = Date.parse('2026-09-25T12:00:00Z')
const ago = (hours: number | null) =>
  hours === null ? null : new Date(NOW - hours * 3_600_000).toISOString()

/** What reconcile's lastEvidenceTimes selects: genuine events, by the holder, latest first. */
const lastEvidence = (events: EvidenceEvent[]) => {
  const genuine: readonly string[] = CLAIM_EVIDENCE_EVENTS.genuine
  const hours = events
    .filter((e) => e.actor === HOLDER && genuine.includes(e.event))
    .map((e) => e.hoursAgo)
  return hours.length ? ago(Math.min(...hours)) : null
}

describe('lastSignOfLife on the shared liveness cases', () => {
  for (const c of LIVENESS_CASES) {
    it(c.name, () => {
      const at = lastSignOfLife(
        {
          claimed_at: ago(c.claimedHoursAgo),
          heartbeat_at: ago(c.heartbeatHoursAgo),
          checkpoint_summary: c.checkpoint,
          checkpoint_at: ago(c.checkpointHoursAgo),
          updated_at: ago(c.updatedHoursAgo),
        },
        ago(c.noteHoursAgo),
        lastEvidence(c.events),
      )
      expect((NOW - at) / 3_600_000).toBe(c.expectedHoursAgo)
    })
  }
})

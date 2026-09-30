import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A todo's HTML attachment is previewed in a frame. An allowance on that
 * frame's sandbox (`allow-scripts`, above all with `allow-same-origin`) would
 * let an uploaded page run script with Croft's origin — read the session's
 * API, act as the viewer. /api/files also serves HTML under a sandbox CSP;
 * this keeps the page's half of that promise checkable from source.
 */
describe('HTML attachments are framed sandboxed', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/app/(app)/projects/[key]/tasks/[number]/attachments-panel.tsx'),
    'utf8',
  )
  const frames = source.match(/<iframe[\s\S]*?\/>/g) ?? []

  it('has frames to check', () => {
    expect(frames.length).toBeGreaterThan(0)
  })

  it('grants no allowance anywhere', () => {
    expect(source).not.toMatch(/allow-(scripts|same-origin|forms|popups|top-navigation|modals)/)
  })

  it('sandboxes every frame except the PDF viewer, which says so', () => {
    for (const frame of frames) {
      if (frame.includes('data-kind="pdf"')) continue
      expect(frame).toContain('sandbox=""')
    }
  })

  it('frames only the PDF kind unsandboxed', () => {
    const pdf = frames.filter((f) => !f.includes('sandbox=""'))
    expect(pdf).toHaveLength(1)
    expect(source).toMatch(/file\.kind === 'pdf' \? \([\s\S]*?data-kind="pdf"/)
  })
})

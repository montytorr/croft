'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MarkdownView } from '@/components/markdown'
import { RelativeTime } from '@/components/relative-time'
import { Button, Textarea } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { useMutate } from '@/lib/api/use-mutate'
import type { Stage } from '@/lib/lab/types'
import { stageTone } from './stage'

/**
 * The conclusion, set above everything else on the page once there is one:
 * it is the sentence anybody arriving at this subject most needs. Framed in
 * the concluding stage's own colour — moss for done, clay for dropped — not
 * the accent, which a conclusion is not.
 */
export const ConclusionCallout = ({
  subjectRef,
  conclusion,
  concludedAt,
  stage,
}: {
  subjectRef: string
  conclusion: string
  concludedAt: string | null
  stage: Pick<Stage, 'color' | 'category' | 'name'>
}) => {
  const router = useRouter()
  const request = useMutate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conclusion)
  const [saving, setSaving] = useState(false)
  const tone = stageTone(stage)

  const save = async () => {
    const next = draft.trim()
    if (!next || next === conclusion) {
      setEditing(false)
      return
    }
    setSaving(true)
    const result = await request(`/api/v1/subjects/${subjectRef}`, { method: 'PATCH', body: { conclusion: next } })
    setSaving(false)
    if (!result.ok) return
    setEditing(false)
    router.refresh()
  }

  return (
    <aside
      aria-label="Conclusion"
      className="relative overflow-hidden rounded-lg border px-4 py-3"
      style={{
        borderColor: `color-mix(in oklab, ${tone} 35%, var(--border))`,
        backgroundColor: `color-mix(in oklab, ${tone} 7%, var(--surface))`,
      }}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: tone }} />
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-fg-muted text-micro font-medium tracking-[0.08em] uppercase">Conclusion</span>
        {concludedAt ? <RelativeTime iso={concludedAt} className="text-fg-subtle text-aux" /> : null}
        {!editing ? (
          <button
            type="button"
            onClick={() => {
              setDraft(conclusion)
              setEditing(true)
            }}
            className="text-fg-subtle hover:text-fg ml-auto text-aux transition-colors"
          >
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <>
          <Textarea
            autoFocus
            rows={4}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="primary" onClick={() => void save()} disabled={saving || !draft.trim()}>
              {saving ? <Spinner /> : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <span className="text-fg-subtle text-aux">⌘↵ save · esc cancel</span>
          </div>
        </>
      ) : (
        <MarkdownView prose="writeup">{conclusion}</MarkdownView>
      )}
    </aside>
  )
}

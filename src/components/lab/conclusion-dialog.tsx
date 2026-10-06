'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { StageBadge } from './stage'
import type { Stage } from '@/lib/lab/types'

/**
 * Entering a completed or dropped stage needs a conclusion: what was learned,
 * and what it means. "Rejected" with no reason is the least useful record a
 * lab can keep — the next person to have the same idea deserves the why.
 *
 * Portalled to the body, because it opens from a dragged card, a list row and
 * the subject sidebar, and any of those gaining a transform would otherwise
 * become the box this `fixed` layer is fixed to.
 */
export const ConclusionDialog = ({
  subjectTitle,
  stage,
  initial = '',
  onCancel,
  onConfirm,
}: {
  subjectTitle: string
  stage: Pick<Stage, 'name' | 'color' | 'category'>
  initial?: string
  onCancel: () => void
  onConfirm: (conclusion: string) => Promise<boolean>
}) => {
  const [value, setValue] = useState(initial)
  const [pending, setPending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = async () => {
    if (!value.trim() || pending) return
    setPending(true)
    const ok = await onConfirm(value.trim())
    if (!ok) setPending(false)
  }

  const dropped = stage.category === 'dropped'

  return createPortal(
    <div className="scrim fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conclusion-title"
        className="bg-surface border-border enter-sheet raised-lg relative w-full max-w-lg rounded-xl border p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-fg-subtle flex items-center gap-1.5 text-aux">
          Moving to <StageBadge stage={stage} className="text-fg-muted font-medium" />
        </p>
        <h2 id="conclusion-title" className="font-display headline text-fg mt-2 text-[1.125rem] leading-snug">
          {dropped ? 'Why is' : 'What did'} “{subjectTitle}” {dropped ? 'being dropped?' : 'conclude?'}
        </h2>
        <p className="text-fg-muted mt-1.5 text-aux leading-relaxed">
          {dropped
            ? 'Say why, so the next person with the same idea starts from here rather than from scratch.'
            : 'What was learned, and what it means for the group. It is the first thing anyone reads on this subject.'}
        </p>

        <textarea
          ref={ref}
          rows={5}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
          placeholder={
            dropped
              ? 'Licence cost scales per seat; at our size it is three times the budget.'
              : 'Works for batch jobs under 10 GB; beyond that the cold start dominates.'
          }
          className="writeup-sm border-border bg-bg text-fg placeholder:text-fg-subtle focus:border-accent mt-4 block w-full resize-y rounded-lg border px-3.5 py-3 outline-none transition-[border-color,box-shadow] duration-[var(--dur-1)] focus:shadow-[0_0_0_1px_var(--accent)]"
        />

        <div className="mt-4 flex items-center gap-2">
          <span className="text-fg-subtle hidden text-aux sm:block">⌘↵ to save</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel} className="px-3">
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void submit()} disabled={!value.trim() || pending} className="px-3">
              {pending ? <Spinner /> : `Conclude and move`}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

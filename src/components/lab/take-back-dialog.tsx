'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import type { Handoff } from '@/lib/lab/types'

/**
 * Taking a hand-off back unlinks the todo so it is worked here again. Nothing
 * is done in the other tracker; its task stays where it is. Cancel has focus.
 */
export const TakeBackDialog = ({
  todoRef,
  handoff,
  onCancel,
  onConfirm,
}: {
  todoRef: string
  handoff: Handoff
  onCancel: () => void
  onConfirm: () => Promise<boolean>
}) => {
  const [pending, setPending] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const confirm = async () => {
    if (pending) return
    setPending(true)
    if (!(await onConfirm())) setPending(false)
  }

  return createPortal(
    <div className="scrim fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <form
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="take-back-title"
        aria-describedby="take-back-body"
        className="bg-surface border-border enter-sheet raised-lg relative w-full max-w-md rounded-xl border p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void confirm()
        }}
      >
        <p className="text-fg-subtle flex items-center gap-1.5 text-aux">
          <Undo2 size={11} aria-hidden /> Take back {todoRef}
        </p>
        <h2 id="take-back-title" className="font-display headline text-fg mt-2 text-[1.125rem] leading-snug">
          Take {todoRef} back from {handoff.tracker}?
        </h2>
        <p id="take-back-body" className="text-fg-muted mt-2 text-ui leading-relaxed">
          {todoRef} stops following <span className="text-fg font-mono">{handoff.ref}</span> and is worked here again.
          Nothing changes in {handoff.tracker}: that task stays where it is.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} type="button" size="sm" variant="ghost" onClick={onCancel} className="px-3">
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={pending} className="px-3">
            {pending ? <Spinner /> : 'Take back'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

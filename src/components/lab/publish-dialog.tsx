'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Globe } from 'lucide-react'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'

/**
 * Publishing is one-way: once a subject is in the lab it cannot be made
 * private again, because by then anyone may have read it, linked it or
 * pushed its todos. The dialog says so before anything happens, and the
 * safe choice (Cancel) is the one that has focus.
 */
export const PublishDialog = ({
  subjectRef,
  subjectTitle,
  onCancel,
  onConfirm,
}: {
  subjectRef: string
  subjectTitle: string
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
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="publish-title"
        aria-describedby="publish-body"
        className="bg-surface border-border enter-sheet raised-lg relative w-full max-w-md rounded-xl border p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-fg-subtle flex items-center gap-1.5 text-[0.6875rem]">
          <Globe size={11} aria-hidden /> Publish {subjectRef}
        </p>
        <h2 id="publish-title" className="font-display headline text-fg mt-2 text-[1.125rem] leading-snug">
          Publish “{subjectTitle}” to the lab?
        </h2>
        <div id="publish-body" className="text-fg-muted mt-2 flex flex-col gap-2 text-[0.8125rem] leading-relaxed">
          <p>Everyone in the lab will see it: the write-up, its todos, notes, files and log, and it shows up in search.</p>
          <p className="text-fg font-medium">This cannot be undone. A published subject cannot be made private again.</p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} size="sm" variant="ghost" onClick={onCancel} className="px-3">
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void confirm()} disabled={pending} className="px-3">
            {pending ? <Spinner /> : 'Publish to the lab'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

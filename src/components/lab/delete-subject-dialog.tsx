'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Deleting is for good: the subject, its todos, log, notes and files go, and
 * there is no archive to restore from. The destructive button stays off until
 * the ref is typed, and the safe choice (Cancel) is the one that has focus.
 */
export const DeleteSubjectDialog = ({
  subjectRef,
  subjectTitle,
  todos,
  onCancel,
  onConfirm,
}: {
  subjectRef: string
  subjectTitle: string
  todos: number
  onCancel: () => void
  onConfirm: () => Promise<boolean>
}) => {
  const [pending, setPending] = useState(false)
  const [typed, setTyped] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const matches = typed.trim() === subjectRef

  const confirm = async () => {
    if (pending || !matches) return
    setPending(true)
    if (!(await onConfirm())) setPending(false)
  }

  return createPortal(
    <div className="scrim fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <form
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        aria-describedby="delete-body"
        className="bg-surface border-border enter-sheet raised-lg relative w-full max-w-md rounded-xl border p-5"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void confirm()
        }}
      >
        <p className="text-fg-subtle flex items-center gap-1.5 text-[0.6875rem]">
          <Trash2 size={11} aria-hidden /> Delete {subjectRef}
        </p>
        <h2 id="delete-title" className="font-display headline text-fg mt-2 text-[1.125rem] leading-snug">
          Delete “{subjectTitle}”?
        </h2>
        <div id="delete-body" className="text-fg-muted mt-2 flex flex-col gap-2 text-[0.8125rem] leading-relaxed">
          <p>
            This removes the subject, its {plural(todos, 'todo')}, its log, human notes and files. Cairn tasks pushed from its
            todos stay in Cairn.
          </p>
          <p className="text-fg font-medium">This cannot be undone.</p>
        </div>

        <label className="text-fg-muted mt-4 flex flex-col gap-1.5 text-[0.75rem]">
          <span>
            Type <span className="text-fg font-mono">{subjectRef}</span> to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={subjectRef}
            className="border-border bg-surface-raised/40 text-fg placeholder:text-fg-subtle focus-visible:ring-ring/40 h-[2rem] rounded-md border px-2 font-mono text-[0.8125rem] outline-none focus-visible:ring-2"
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} type="button" size="sm" variant="ghost" onClick={onCancel} className="px-3">
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="danger" disabled={!matches || pending} className="px-3">
            {pending ? <Spinner /> : 'Delete subject'}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

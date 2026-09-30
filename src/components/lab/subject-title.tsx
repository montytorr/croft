'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useMutate } from '@/lib/api/use-mutate'
import { cn } from '@/lib/utils'

/**
 * Shared by the heading and the textarea that replaces it, so clicking to
 * edit does not move a glyph. The largest type in the product: the subject's
 * name is the one voice on its page.
 */
const TITLE =
  'font-display headline headline-xl text-fg -mx-2 rounded-lg border px-2 text-[1.75rem] leading-[1.15] sm:text-[2.125rem] ' +
  'transition-[background-color,box-shadow] duration-[var(--dur-1)] ease-[var(--ease-out)]'

/** Click-to-edit title; Enter saves, Escape puts it back. */
export const SubjectTitle = ({ subjectRef, initial }: { subjectRef: string; initial: string }) => {
  const router = useRouter()
  const request = useMutate()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing || !ref.current) return
    const el = ref.current
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editing])

  const save = async () => {
    const next = value.trim()
    if (!next || next === initial) {
      setValue(initial)
      setEditing(false)
      return
    }
    setSaving(true)
    const result = await request(`/api/v1/subjects/${subjectRef}`, { method: 'PATCH', body: { title: next } })
    setSaving(false)
    // A refused title stays in the field, text intact, with the reason on the toast.
    if (!result.ok) return
    setEditing(false)
    router.refresh()
  }

  if (!editing) {
    return (
      <h1
        onClick={() => {
          setValue(initial)
          setEditing(true)
        }}
        className={cn(TITLE, 'hover:bg-surface-hover cursor-text border-transparent')}
        title="Click to rename"
      >
        {initial}
      </h1>
    )
  }

  return (
    <textarea
      ref={ref}
      value={value}
      disabled={saving}
      maxLength={300}
      rows={1}
      aria-label="Title"
      onChange={(e) => {
        setValue(e.target.value)
        e.target.style.height = 'auto'
        e.target.style.height = `${e.target.scrollHeight}px`
      }}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          void save()
        }
        if (e.key === 'Escape') {
          setValue(initial)
          setEditing(false)
        }
      }}
      className={cn(TITLE, 'border-accent bg-surface ring-accent block w-[calc(100%+1rem)] resize-none ring-1 outline-none')}
    />
  )
}

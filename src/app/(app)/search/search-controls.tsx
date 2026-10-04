'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Spinner } from '@/components/spinner'
import { Search as SearchIcon, X } from 'lucide-react'
import { Input, Select } from '@/components/ui/control'
import { cn } from '@/lib/utils'

const Filter = ({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: { value: string; label: string }[]
}) => (
  <Select
    size="sm"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    aria-label={placeholder}
    className={cn('w-auto', value ? 'text-fg' : 'text-fg-subtle')}
  >
    <option value="">{placeholder}</option>
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </Select>
)

/**
 * The query lives in the URL so a search can be linked to and shared — which
 * is the difference between a lookup and a citable answer. The input is
 * debounced into it rather than pushed per keystroke.
 */
export const SearchControls = ({
  q,
  kind,
}: {
  q: string
  kind: string
}) => {
  const router = useRouter()
  // The query lives in the URL, so every keystroke is a server round trip.
  // Without this the page sat completely still while it ran — a searchParams
  // change does not reliably surface loading.tsx, so the feedback has to come
  // from the control that started it.
  const [running, startSearch] = useTransition()
  const [draft, setDraft] = useState(q)
  const inputRef = useRef<HTMLInputElement>(null)
  // The committed query, so the debounce does not re-push the URL it just
  // arrived from.
  const committed = useRef(q)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const push = (next: {
    q?: string
    kind?: string
  }) => {
    const params = new URLSearchParams()
    const merged = { q: draft, kind, ...next }
    if (merged.kind === 'all') merged.kind = ''
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value)
    }
    committed.current = merged.q ?? ''
    startSearch(() => router.replace(`/search?${params.toString()}`))
  }

  useEffect(() => {
    if (draft === committed.current) return
    const timer = setTimeout(() => push({ q: draft }), 260)
    return () => clearTimeout(timer)
    // `push` closes over the current filters; re-creating it each render is
    // fine because only `draft` drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // True between the last keystroke and the URL catching up, so the spinner
  // appears immediately rather than after the debounce. Compared against the
  // `q` prop, not the ref: a ref read during render neither re-renders when it
  // changes nor is sound under concurrent rendering.
  const pendingDebounce = draft.trim() !== q.trim()
  const cleared = !q && (!kind || kind === 'all')

  return (
    <div className="border-border/70 flex shrink-0 flex-col gap-2 border-b px-3 py-2 sm:h-[2.625rem] sm:flex-row sm:items-center sm:px-4 sm:py-0">
      {/* The one field on the page that matters, so it is drawn as a field:
          a well whose rim turns to the accent on focus, rather than bare text on the
          bar that only a blinking caret distinguished from a label. */}
      <div className="relative flex min-w-0 flex-1 items-center">
        <span
          className={cn(
            'pointer-events-none absolute left-2.5 z-10 grid size-[0.875rem] place-items-center transition-colors duration-[var(--dur-1)]',
            draft ? 'text-accent' : 'text-fg-subtle',
          )}
        >
          {running || pendingDebounce ? <Spinner size={13} /> : <SearchIcon size={13} aria-hidden />}
        </span>
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDraft('')
          }}
          placeholder="Has this already been done or debugged?"
          aria-label="Search tasks"
          className="min-w-0 flex-1 pr-8 pl-8 sm:pr-2.5"
        />
        {draft && (
          <button
            type="button"
            onClick={() => setDraft('')}
            aria-label="Clear the search"
            className="text-fg-subtle hover:text-fg absolute right-2 z-10 shrink-0 sm:hidden"
          >
            <X size={13} aria-hidden />
          </button>
        )}
      </div>
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 [scrollbar-width:none] sm:mx-0 sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
      <Filter
        value={kind === 'all' ? '' : kind}
        onChange={(v) => push({ kind: v || 'all' })}
        placeholder="Everything"
        options={[
          { value: 'subject', label: 'Subjects' },
          { value: 'task', label: 'Todos' },
          { value: 'note', label: 'Todo notes' },
        ]}
      />
      {!cleared && (
        <button
          type="button"
          onClick={() => {
            setDraft('')
            committed.current = ''
            router.replace('/search')
          }}
          className="text-fg-subtle hover:text-fg shrink-0 whitespace-nowrap text-[0.75rem] transition-colors"
        >
          Clear
        </button>
      )}
      </div>
    </div>
  )
}

'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

import { SUBJECT_TABS, isSubjectTab, type SubjectTab } from '@/lib/lab/ui-subject-tabs'

export { SUBJECT_TABS, isSubjectTab, type SubjectTab }

const LABELS: Record<SubjectTab, string> = {
  writeup: 'Write-up',
  todos: 'Todos',
  notes: 'Notes',
  log: 'Log',
  files: 'Files',
  details: 'Details',
}

const TabContext = createContext<(tab: SubjectTab) => void>(() => {})

/** Opens another section of the subject page, from inside one (the write-up's "all todos →"). */
export const useOpenTab = () => useContext(TabContext)

/**
 * The subject page's body: a bar of sections under the header band, the open
 * one filling the width, and the properties rail beside it.
 *
 * Every section stays mounted and is only hidden, so a half-written note or a
 * board mid-scroll survives a look at the write-up. The open section is in the
 * URL (`?tab=todos`) through the history API rather than a navigation, so a
 * switch never waits on the server and a link can still open one directly.
 *
 * On a phone the rail becomes a section of its own, Details; from `lg` it is
 * always beside the page and that tab is gone.
 */
export const SubjectWorkspace = ({
  initialTab,
  counts,
  panels,
  rail,
}: {
  initialTab: SubjectTab
  counts: Partial<Record<SubjectTab, string | number>>
  panels: Record<Exclude<SubjectTab, 'details'>, React.ReactNode>
  rail: React.ReactNode
}) => {
  const [tab, setTab] = useState<SubjectTab>(initialTab)
  const bar = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)

  const open = useCallback((next: SubjectTab) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (next === 'writeup') url.searchParams.delete('tab')
    else url.searchParams.set('tab', next)
    window.history.replaceState(window.history.state, '', url)
    // Back to the top of the section, not wherever the last one was scrolled.
    // The bar is sticky, so its own offset is wherever it is stuck; the body
    // under it is where the sections really start.
    const box = bar.current?.closest('[data-scroll-root]')
    const top = (body.current?.offsetTop ?? 0) - (bar.current?.offsetHeight ?? 0)
    if (box && box.scrollTop > top) box.scrollTo({ top })
  }, [])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const visible = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter((b) => b.offsetParent !== null)
    const at = visible.findIndex((b) => b === document.activeElement)
    const next = visible[(at + (e.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length]
    next?.focus()
    next?.click()
  }

  // Details is the rail; on a wide screen the rail is already there, so the
  // write-up stands in for it.
  const main = tab === 'details' ? 'writeup' : tab

  return (
    <TabContext.Provider value={open}>
      <div
        ref={bar}
        className="bg-bg border-border sticky top-0 z-20 border-b"
      >
        <div
          role="tablist"
          aria-label="Sections"
          onKeyDown={onKeyDown}
          className="flex items-center gap-4 overflow-x-auto px-4 [scrollbar-width:none] md:gap-5 md:px-6"
        >
          {SUBJECT_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`tab-${t}`}
              aria-selected={tab === t}
              aria-controls={t === 'details' ? 'subject-rail' : `panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => open(t)}
              className={cn('section-tab', t === 'details' && 'lg:hidden!')}
            >
              {LABELS[t]}
              {counts[t] !== undefined && counts[t] !== 0 && counts[t] !== '' ? <span className="count">{counts[t]}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div ref={body} className="lg:flex lg:items-start">
        <div className={cn('min-w-0 flex-1', tab === 'details' && 'hidden lg:block')}>
          {(Object.keys(panels) as (keyof typeof panels)[]).map((key) => (
            <section
              key={key}
              id={`panel-${key}`}
              role="tabpanel"
              aria-labelledby={`tab-${key}`}
              hidden={main !== key}
              className="px-4 pt-5 pb-16 md:px-6"
            >
              {panels[key]}
            </section>
          ))}
        </div>
        <aside
          id="subject-rail"
          aria-label="Details"
          className={cn(
            'border-border shrink-0 px-4 pt-5 pb-10 md:px-6',
            'lg:sticky lg:top-[2.5625rem] lg:max-h-[calc(100dvh-5.5rem)] lg:w-[16rem] lg:overflow-y-auto lg:border-l lg:px-5 lg:pb-8',
            tab === 'details' ? 'block' : 'hidden lg:block',
          )}
        >
          {rail}
        </aside>
      </div>
    </TabContext.Provider>
  )
}

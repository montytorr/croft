'use client'

import { usePathname } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { CreateTask } from './create-task'
import { createsTodo, typingInField } from '@/lib/lab/ui-shortcuts'

type Ctx = { open: () => void }
const CreateContext = createContext<Ctx>({ open: () => undefined })

export const useCreateTask = () => useContext(CreateContext)

/**
 * Holds the create dialog once, at the root, so any button can open it and
 * `c` works from anywhere. Mounting it per-view would mean several copies of
 * the same state and a shortcut that only fires on some pages.
 */
export const TaskCreationProvider = ({
  projects,
  children,
}: {
  projects: { key: string; title: string }[]
  children: React.ReactNode
}) => {
  const [isOpen, setIsOpen] = useState(false)
  // Bumped on each open so <CreateTask> remounts with fresh state, instead of
  // an effect resetting half a dozen fields.
  const [instance, setInstance] = useState(0)
  const pathname = usePathname()

  // Creating from inside a project should default to that project.
  const projectFromPath = useMemo(() => {
    const match = /^\/projects\/([^/]+)/.exec(pathname ?? '')
    return match?.[1]?.toUpperCase()
  }, [pathname])

  const open = useCallback(() => {
    setInstance((n) => n + 1)
    setIsOpen(true)
  }, [])

  // `c` is a todo only on the todo surfaces; elsewhere it is a new subject,
  // which SubjectCreationProvider answers.
  const todoSurface = createsTodo(pathname)

  useEffect(() => {
    if (!todoSurface) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (typingInField()) return
      if (e.key === 'c') {
        e.preventDefault()
        setInstance((n) => n + 1)
        setIsOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [todoSurface])

  const value = useMemo(() => ({ open }), [open])

  return (
    <CreateContext.Provider value={value}>
      {children}
      <CreateTask
        key={instance}
        projects={projects}
        defaultProject={projectFromPath}
        open={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </CreateContext.Provider>
  )
}

/** The button that appears in list headers. */
export const NewTaskButton = () => {
  const { open } = useCreateTask()
  return (
    <button
      type="button"
      onClick={open}
      title="New todo — c"
      className="border-border bg-surface text-fg-muted hover:border-border-strong hover:bg-surface-raised hover:text-fg flex h-[1.625rem] items-center gap-1.5 rounded-md border px-2 text-[0.75rem] shadow-[var(--shadow-sm)] transition-[color,background-color,border-color] duration-[var(--dur-1)] ease-[var(--ease-out)] active:scale-[0.98]"
    >
      New todo
      <kbd className="kbd hidden sm:inline-flex">c</kbd>
    </button>
  )
}

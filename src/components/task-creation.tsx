'use client'

import { usePathname } from 'next/navigation'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { CreateTask } from './create-task'
import { createsTodo, todoContext, typingInField } from '@/lib/lab/ui-shortcuts'

type Ctx = { open: () => void }
const CreateContext = createContext<Ctx>({ open: () => undefined })

export const useCreateTask = () => useContext(CreateContext)

/**
 * Holds the create dialog once, at the root, so any button can open it and
 * `c` works from anywhere. Mounting it per-view would mean several copies of
 * the same state and a shortcut that only fires on some pages.
 */
export const TaskCreationProvider = ({ children }: { children: React.ReactNode }) => {
  const [isOpen, setIsOpen] = useState(false)
  // Bumped on each open so <CreateTask> remounts with fresh state, instead of
  // an effect resetting half a dozen fields.
  const [instance, setInstance] = useState(0)
  const pathname = usePathname()

  // Creating from a subject's page defaults to that subject; from a todo's
  // page it can be a sub-task of it.
  const context = useMemo(() => todoContext(pathname), [pathname])
  const close = useCallback(() => setIsOpen(false), [])

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
        context={context}
        open={isOpen}
        onClose={close}
      />
    </CreateContext.Provider>
  )
}

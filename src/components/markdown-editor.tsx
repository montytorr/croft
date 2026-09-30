'use client'

import { EditorContent, useEditor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import { useCallback, useEffect, useRef, useState } from 'react'
import { editorExtensions } from '@/lib/editor/markdown'
import { MarkdownView } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { mutate } from '@/lib/api/mutate'
import { Button } from '@/components/ui/control'

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/**
 * Click-to-edit markdown body.
 *
 * The body is markdown on the wire and in the database; Tiptap is only the
 * editing surface. The extension set is constrained to GFM-representable
 * constructs — see docs/tiptap-markdown-spike.md for what that costs and why.
 */
export const MarkdownEditor = ({
  taskId,
  initial,
}: {
  taskId: string
  initial: string
}) => {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(initial)
  const [state, setState] = useState<SaveState>('idle')
  // The markdown as it was when editing began, so an unchanged body is never
  // written back — the single most effective guard against the round trip
  // silently rewriting something an agent wrote.
  const baseline = useRef(initial)

  const editor = useEditor(
    {
      extensions: [
        ...editorExtensions(),
        Placeholder.configure({ placeholder: 'Describe the task. Markdown, / for commands.' }),
      ],
      content: value,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: 'outline-none min-h-32 text-sm leading-relaxed',
        },
      },
      onUpdate: () => setState('dirty'),
    },
    [editing],
  )

  const save = useCallback(async () => {
    if (!editor) return
    const markdown = editor.storage.markdown.getMarkdown()

    if (markdown === baseline.current) {
      setState('idle')
      setEditing(false)
      return
    }

    setState('saving')
    // Without a try/catch a dropped connection never resolved this, and the
    // button sat on "Saving…" until the page was left — with the edit still
    // unsaved.
    const result = await mutate(`/api/v1/tasks/${taskId}`, {
      method: 'PATCH',
      body: { description: markdown },
    })

    if (!result.ok) {
      setState('error')
      return
    }

    baseline.current = markdown
    setValue(markdown)
    setState('saved')
    setEditing(false)
  }, [editor, taskId])

  useEffect(() => {
    if (!editing) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEditing(false)
        setState('idle')
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void save()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [editing, save])

  if (!editing) {
    return (
      <div className="group relative">
        {/* The PROP, not the state. `value` is seeded once at mount, so
            rendering it here meant a description rewritten by an agent never
            appeared until a full reload — the body was the one part of the
            task page that could not catch up. Editors must not sync a prop
            into state while open (it would clobber typing), so this reads the
            prop when closed and seeds state when editing starts, exactly as
            editable-title.tsx does. */}
        {initial.trim() ? (
          <MarkdownView>{initial}</MarkdownView>
        ) : (
          <p className="text-fg-subtle text-sm italic">No description.</p>
        )}
        <button
          type="button"
          onClick={() => {
            // Seed from the current prop at the moment editing starts.
            setValue(initial)
            baseline.current = initial
            setEditing(true)
          }}
          className="text-fg-subtle hover:text-fg border-border hover:border-border-strong bg-surface-raised absolute -top-1 right-0 rounded-md border px-2 py-0.5 text-[0.6875rem] opacity-0 transition-[opacity,color,border-color] duration-[var(--dur-1)] ease-[var(--ease-out)] group-hover:opacity-100 focus-visible:opacity-100"
        >
          Edit
        </button>
        {state === 'saved' && (
          <span className="enter-rise text-status-done absolute -top-1 right-14 text-[0.6875rem]">saved</span>
        )}
      </div>
    )
  }

  return (
    <div>
      <div
        className={cn(
          'surface-card p-3 transition-[border-color,box-shadow] duration-[var(--dur-2)] ease-[var(--ease-out)]',
          'focus-within:border-accent focus-within:ring-1 focus-within:ring-accent',
          state === 'error' && 'border-danger focus-within:border-danger focus-within:ring-danger',
        )}
      >
        <EditorContent editor={editor} className="prose-editor" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => void save()}
          disabled={state === 'saving'}
          className="px-3"
        >
          {state === 'saving' ? 'Saving…' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(false)
            setState('idle')
          }}
          className="px-3 font-normal"
        >
          Cancel
        </Button>
        <span className="text-fg-subtle text-[0.6875rem]">⌘↵ save · esc cancel</span>
        {state === 'error' && (
          <span className="text-danger text-[0.6875rem]">Save failed — nothing was changed.</span>
        )}
      </div>
    </div>
  )
}

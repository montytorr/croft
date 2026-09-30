'use client'

import { EditorContent, useEditor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, PenLine, X } from 'lucide-react'
import { MarkdownView } from '@/components/markdown'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { editorExtensions } from '@/lib/editor/markdown'
import { mutate } from '@/lib/api/mutate'
import { cn } from '@/lib/utils'

type Mode = 'rich' | 'source'
type SaveState = 'idle' | 'saving' | 'error'

const PLACEHOLDER = 'What is it, why does it matter, what have we found? Markdown works; S-12 and T-41 link themselves.'

/**
 * The editor, full width, with the page it will become beside it.
 *
 * Two ways to write: rich (Tiptap, the same GFM-constrained editor as a
 * todo's description) and source (the markdown itself, which never rewrites
 * a line an agent wrote). The preview on the right is the real renderer —
 * refs linked, code highlighted, set in the write-up's serif — and follows
 * either one as you type.
 */
const Editor = ({
  subjectRef,
  title,
  initial,
  onClose,
}: {
  subjectRef: string
  title: string
  initial: string
  onClose: (saved: boolean) => void
}) => {
  const [mode, setMode] = useState<Mode>('rich')
  const [markdown, setMarkdown] = useState(initial)
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [pane, setPane] = useState<'edit' | 'preview'>('edit')
  const baseline = useRef(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const editor = useEditor({
    extensions: [...editorExtensions(), Placeholder.configure({ placeholder: PLACEHOLDER })],
    content: initial,
    immediatelyRender: false,
    editorProps: { attributes: { class: 'min-h-[60vh] pb-24' } },
    // Serialising on every keystroke is wasted work on a long write-up; the
    // preview only has to keep up with a reader's eye.
    onUpdate: ({ editor: e }) => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setMarkdown(e.storage.markdown.getMarkdown()), 140)
    },
  })

  useEffect(() => () => clearTimeout(timer.current), [])

  const current = useCallback(
    () => (mode === 'rich' && editor ? editor.storage.markdown.getMarkdown() : markdown),
    [editor, markdown, mode],
  )

  const switchMode = (next: Mode) => {
    if (next === mode) return
    if (next === 'source' && editor) {
      clearTimeout(timer.current)
      setMarkdown(editor.storage.markdown.getMarkdown())
    }
    if (next === 'rich' && editor) editor.commands.setContent(markdown)
    setMode(next)
  }

  const save = useCallback(async () => {
    const body = current()
    if (body === baseline.current) {
      onClose(false)
      return
    }
    setState('saving')
    setError(null)
    const result = await mutate(`/api/v1/subjects/${subjectRef}`, { method: 'PATCH', body: { body } })
    if (!result.ok) {
      setState('error')
      setError(result.error)
      return
    }
    baseline.current = body
    onClose(true)
  }, [current, onClose, subjectRef])

  const dirty = useCallback(() => current() !== baseline.current, [current])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void save()
      }
      // Escape leaves only when there is nothing to lose; otherwise it is
      // Cancel's job, which asks.
      if (e.key === 'Escape' && !dirty()) onClose(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [save, dirty, onClose])

  // Nothing behind the editor should scroll while it is open.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const cancel = () => {
    if (dirty() && !window.confirm('Discard the changes to this write-up?')) return
    onClose(false)
  }

  const tab = (value: Mode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => switchMode(value)}
      className={cn(
        'h-[1.625rem] rounded-md px-2.5 text-[0.75rem] transition-colors duration-[var(--dur-1)]',
        mode === value ? 'bg-surface text-fg ring-border ring-1' : 'text-fg-muted hover:text-fg',
      )}
    >
      {label}
    </button>
  )

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={`Editing the write-up of ${title}`} className="bg-bg enter-fade fixed inset-0 z-50 flex flex-col">
      <header className="border-border flex h-[3.25rem] shrink-0 items-center gap-3 border-b px-3 md:px-6">
        <button type="button" onClick={cancel} aria-label="Close the editor" className="text-fg-subtle hover:text-fg hover:bg-surface-hover grid size-8 place-items-center rounded-md transition-colors">
          <X size={16} aria-hidden />
        </button>
        <div className="min-w-0">
          <p className="text-fg-subtle text-[0.6875rem]">
            Write-up · <span className="font-mono">{subjectRef}</span>
          </p>
          <p className="text-fg truncate text-[0.875rem] font-medium">{title}</p>
        </div>
        <div className="bg-surface-raised ml-auto hidden items-center gap-0.5 rounded-lg p-0.5 sm:flex" role="group" aria-label="Editor">
          {tab('rich', 'Rich')}
          {tab('source', 'Markdown')}
        </div>
        <button
          type="button"
          onClick={() => setPane((p) => (p === 'edit' ? 'preview' : 'edit'))}
          className="text-fg-muted hover:text-fg flex items-center gap-1.5 text-[0.75rem] lg:hidden"
        >
          {pane === 'edit' ? <Eye size={14} aria-hidden /> : <PenLine size={14} aria-hidden />}
          {pane === 'edit' ? 'Preview' : 'Edit'}
        </button>
        <span className="text-fg-subtle hidden text-[0.6875rem] md:block">⌘↵ save</span>
        <Button variant="ghost" size="sm" onClick={cancel} className="px-3 font-normal">
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={state === 'saving'} className="px-3.5">
          {state === 'saving' ? <Spinner /> : 'Save write-up'}
        </Button>
      </header>

      {error ? (
        <p className="text-danger bg-danger-subtle border-border border-b px-6 py-2 text-[0.75rem]" role="alert">
          {error} Nothing was saved; your text is still here.
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 lg:grid-cols-2">
        <section
          aria-label="Edit"
          className={cn('border-border min-h-0 overflow-y-auto lg:block lg:border-r', pane === 'edit' ? 'block' : 'hidden')}
        >
          <div className="mx-auto max-w-[44rem] px-5 py-8 md:px-10">
            {/* Kept mounted in source mode, only hidden, so the rich editor's
                view is never torn down and re-attached mid-session. */}
            <EditorContent editor={editor} className={cn('prose-editor writeup', mode !== 'rich' && 'hidden')} />
            {mode === 'source' ? (
              <textarea
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                spellCheck
                placeholder={PLACEHOLDER}
                className="text-fg placeholder:text-fg-subtle block min-h-[70vh] w-full resize-none bg-transparent font-mono text-[0.8125rem] leading-[1.7] outline-none"
              />
            ) : null}
          </div>
        </section>
        <section
          aria-label="Preview"
          className={cn('bg-bg-elevated/60 min-h-0 overflow-y-auto lg:block', pane === 'preview' ? 'block' : 'hidden')}
        >
          <div className="mx-auto max-w-[44rem] px-5 py-8 md:px-10">
            <p className="text-fg-subtle mb-4 text-[0.625rem] font-medium tracking-[0.08em] uppercase">Preview</p>
            {markdown.trim() ? (
              <MarkdownView prose="writeup">{markdown}</MarkdownView>
            ) : (
              <p className="writeup text-fg-subtle italic">Nothing written yet.</p>
            )}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  )
}

/**
 * A subject's write-up: the long-form account of it, set as something to be
 * read — Newsreader, a book measure, a margin rule down the left like a
 * notebook page. "Edit" is always visible rather than a hover affordance,
 * because writing this is the point of the page.
 */
export const WriteUp = ({
  subjectRef,
  title,
  body,
}: {
  subjectRef: string
  title: string
  body: string | null
}) => {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  // Seeded from the prop when editing starts, never synced while open: an
  // agent's edit arriving under a live refresh must not clobber typing.
  const [seed, setSeed] = useState(body ?? '')

  const close = useCallback(
    (saved: boolean) => {
      setEditing(false)
      if (saved) {
        setSavedAt(Date.now())
        router.refresh()
      }
    },
    [router],
  )

  const text = body ?? ''

  return (
    <section aria-labelledby="writeup-heading">
      <div className="mb-4 flex items-center gap-3">
        <h2 id="writeup-heading" className="text-fg-subtle text-[0.625rem] font-medium tracking-[0.08em] uppercase">
          Write-up
        </h2>
        {savedAt ? <span className="enter-rise text-status-done text-[0.6875rem]">saved</span> : null}
        <Button
          variant={text.trim() ? 'secondary' : 'primary'}
          size="sm"
          onClick={() => {
            setSeed(text)
            setEditing(true)
          }}
          className="ml-auto px-3"
        >
          <PenLine size={13} aria-hidden />
          {text.trim() ? 'Edit' : 'Start the write-up'}
        </Button>
      </div>

      <div className="border-border border-l pl-5 md:pl-7">
        {text.trim() ? (
          <MarkdownView prose="writeup">{text}</MarkdownView>
        ) : (
          <button
            type="button"
            onClick={() => {
              setSeed('')
              setEditing(true)
            }}
            className="writeup text-fg-subtle hover:text-fg-muted block w-full py-6 text-left italic transition-colors"
          >
            Nothing written yet. What is it, why does it matter, and what have we found?
          </button>
        )}
      </div>

      {editing ? <Editor subjectRef={subjectRef} title={title} initial={seed} onClose={close} /> : null}
    </section>
  )
}

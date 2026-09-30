'use client'

import { EditorContent, useEditor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import type { EditorView } from '@tiptap/pm/view'
import { useRouter } from 'next/navigation'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Eye, ImagePlus, PenLine, X } from 'lucide-react'
import { MarkdownView } from '@/components/markdown'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { editorExtensions, richEditLoss } from '@/lib/editor/markdown'
import { imageFiles, imageMarkdown, insertAt, settlePlaceholder, uploadPlaceholder, uploadSubjectFile } from '@/lib/editor/upload'
import { mutate } from '@/lib/api/mutate'
import { cn } from '@/lib/utils'

type Mode = 'rich' | 'source'
type SaveState = 'idle' | 'saving' | 'error'

const PLACEHOLDER =
  'What is it, why does it matter, what have we found? Markdown works; S-12 and T-41 link themselves; paste or drop an image to add it.'

type UploadReport = { start: () => void; end: (error: string | null) => void }

/**
 * Images pasted or dropped into the rich editor: each uploaded to the subject,
 * then placed as an image node where it was dropped (or at the caret, when
 * the text moved meanwhile). The node serialises to `![name](content_url)`,
 * the stable URL, so the write-up never embeds a signed link that expires.
 */
const uploadIntoView = async (view: EditorView, files: File[], pos: number, subjectRef: string, report: UploadReport) => {
  let at = pos
  for (const file of files) {
    const before = view.state.doc
    report.start()
    const result = await uploadSubjectFile(subjectRef, file)
    report.end(result.ok ? null : `${file.name}: ${result.error}`)
    if (!result.ok || view.isDestroyed) continue
    const node = view.state.schema.nodes.image?.create({ src: result.data.content_url, alt: result.data.filename })
    if (!node) continue
    const target = view.state.doc === before ? Math.min(at, view.state.doc.content.size) : view.state.selection.to
    const tr = view.state.tr.replaceRangeWith(target, target, node)
    view.dispatch(tr)
    at = tr.mapping.map(target)
  }
}

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
  const [mode, setMode] = useState<Mode>(() => (richEditLoss(initial) ? 'source' : 'rich'))
  const [markdown, setMarkdown] = useState(initial)
  // A body with a table is checked by round-tripping it, which is too much to
  // repeat on every keystroke; the tab's state can trail the text slightly,
  // and switchMode checks the text as it is.
  const deferred = useDeferredValue(markdown)
  const richLoss = useMemo(() => (mode === 'source' ? richEditLoss(deferred) : null), [mode, deferred])
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [pane, setPane] = useState<'edit' | 'preview'>('edit')
  const [uploads, setUploads] = useState(0)
  const baseline = useRef(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const source = useRef<HTMLTextAreaElement>(null)

  // Setters only, so the editor's paste and drop handlers can hold it for
  // the editor's whole life without going stale.
  const report = useMemo<UploadReport>(
    () => ({
      start: () => setUploads((n) => n + 1),
      end: (message) => {
        setUploads((n) => n - 1)
        if (message) setError(message)
      },
    }),
    [],
  )

  const editor = useEditor({
    extensions: [...editorExtensions(), Placeholder.configure({ placeholder: PLACEHOLDER })],
    content: initial,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'min-h-[60vh] pb-24' },
      handlePaste: (view, event) => {
        const files = imageFiles(event.clipboardData)
        if (!files.length) return false
        event.preventDefault()
        void uploadIntoView(view, files, view.state.selection.to, subjectRef, report)
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        const files = moved ? [] : imageFiles(event.dataTransfer)
        if (!files.length) return false
        event.preventDefault()
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.to
        void uploadIntoView(view, files, pos, subjectRef, report)
        return true
      },
    },
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

  /** The markdown side of paste and drop: a placeholder at the caret at once, the image in its place when it lands. */
  const uploadIntoSource = async (files: File[]) => {
    const el = source.current
    for (const file of files) {
      const token = uploadPlaceholder(file.name, Math.random().toString(36).slice(2, 8))
      setMarkdown((text) => {
        const { text: next, caret } = insertAt(text, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, token)
        requestAnimationFrame(() => el?.setSelectionRange(caret, caret))
        return next
      })
      report.start()
      const result = await uploadSubjectFile(subjectRef, file)
      report.end(result.ok ? null : `${file.name}: ${result.error}`)
      setMarkdown((text) => settlePlaceholder(text, token, result.ok ? imageMarkdown(result.data) : ''))
    }
  }

  const switchMode = (next: Mode) => {
    if (next === mode) return
    if (next === 'rich' && richEditLoss(markdown)) return
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
      disabled={value === 'rich' && !!richLoss}
      title={value === 'rich' && richLoss ? `${richLoss} Edit it as markdown.` : undefined}
      onClick={() => switchMode(value)}
      className={cn(
        'h-[1.625rem] rounded-md px-2.5 text-[0.75rem] transition-colors duration-[var(--dur-1)]',
        'disabled:cursor-not-allowed disabled:opacity-45',
        mode === value ? 'bg-surface text-fg ring-border ring-1' : 'text-fg-muted hover:text-fg',
      )}
    >
      {label}
    </button>
  )

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Editing the write-up of ${title}`}
      className="bg-bg enter-fade fixed inset-0 z-50 flex flex-col"
      // A file let go outside the editor would otherwise replace the page with
      // itself, and the unsaved write-up with it.
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
    >
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
        {uploads > 0 ? (
          <span className="text-fg-muted flex items-center gap-1.5 text-[0.6875rem]" role="status">
            <Spinner size={11} /> Uploading {uploads === 1 ? 'an image' : `${uploads} images`}…
          </span>
        ) : (
          <span className="text-fg-subtle hidden items-center gap-1 text-[0.6875rem] xl:flex" title="Paste or drop an image into the text">
            <ImagePlus size={12} aria-hidden /> paste an image
          </span>
        )}
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
          {error} {state === 'error' ? 'Nothing was saved; your text is still here.' : 'The rest of your text is untouched.'}
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
                ref={source}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                onPaste={(e) => {
                  const files = imageFiles(e.clipboardData)
                  if (!files.length) return
                  e.preventDefault()
                  void uploadIntoSource(files)
                }}
                onDrop={(e) => {
                  const files = imageFiles(e.dataTransfer)
                  if (!files.length) return
                  e.preventDefault()
                  void uploadIntoSource(files)
                }}
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

/** "1,240 words · 6 min read", or null for a short one where the count says nothing. */
const readingLength = (text: string) => {
  const words = text.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length
  if (words < 120) return null
  return `${words.toLocaleString('en-GB')} words · ${Math.max(1, Math.round(words / 230))} min read`
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
  const length = readingLength(text)

  return (
    <section aria-labelledby="writeup-heading">
      <div className="mb-3 flex h-7 items-center gap-3">
        <h2 id="writeup-heading" className="pane-label">
          Write-up
        </h2>
        {length ? <span className="text-fg-subtle text-[0.6875rem] tabular-nums">{length}</span> : null}
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

      <div id="writeup-body" className="border-border border-l pl-4 md:pl-6">
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

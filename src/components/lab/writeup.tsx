'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Code2, Eye, ImagePlus, PenLine, X } from 'lucide-react'
import { MarkdownView } from '@/components/markdown'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { imageFiles, imageMarkdown, insertAt, settlePlaceholder, uploadPlaceholder, uploadSubjectFile } from '@/lib/editor/upload'
import { mutate } from '@/lib/api/mutate'
import { cn } from '@/lib/utils'

type SaveState = 'idle' | 'saving' | 'error'

const PLACEHOLDER =
  'What is it, why does it matter, what have we found? Markdown works; S-12 and T-41 link themselves; paste or drop an image to add it.'

type UploadReport = { start: () => void; end: (error: string | null) => void }

/** Raw Markdown is the source of truth. Only the preview is rendered. */
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
  const [markdown, setMarkdown] = useState(initial)
  const preview = useDeferredValue(markdown)
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [pane, setPane] = useState<'edit' | 'preview'>('edit')
  const [uploads, setUploads] = useState(0)
  const baseline = useRef(initial)
  const source = useRef<HTMLTextAreaElement>(null)

  // Uploads may finish while the author continues typing.
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

  const current = useCallback(() => markdown, [markdown])

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

  const save = useCallback(async () => {
    if (uploads || state === 'saving') return
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
  }, [current, onClose, state, subjectRef, uploads])

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
    if (state === 'saving') return
    if (dirty() && !window.confirm('Discard the changes to this write-up?')) return
    onClose(false)
  }

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
      <header className="bg-surface border-border flex min-h-16 shrink-0 items-center gap-2 border-b px-3 py-2 md:gap-3 md:px-6">
        <button type="button" onClick={cancel} disabled={state === 'saving'} aria-label="Close the editor" className="text-fg-subtle hover:text-fg hover:bg-surface-hover grid size-8 place-items-center rounded-md transition-colors">
          <X size={16} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-fg-subtle text-[0.6875rem]">
            Write-up · <span className="font-mono">{subjectRef}</span>
          </p>
          <p className="text-fg truncate text-[0.875rem] font-medium">{title}</p>
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
        <Button variant="ghost" size="sm" onClick={cancel} disabled={state === 'saving'} className="hidden px-3 font-normal sm:inline-flex">
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={state === 'saving' || uploads > 0} className="shrink-0 px-3.5">
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
          aria-label="Markdown source"
          className={cn('border-border min-h-0 overflow-y-auto lg:block lg:border-r', pane === 'edit' ? 'block' : 'hidden')}
        >
          <div className="editor-pane-heading"><Code2 size={14} aria-hidden /> Markdown <span className="ml-auto font-normal normal-case tracking-normal">Plain text</span></div>
          <div className="px-5 py-6 md:px-8 md:py-8">
            <textarea
                ref={source}
                autoFocus
                aria-label="Write-up Markdown"
                disabled={state === 'saving'}
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
                spellCheck={false}
                placeholder={PLACEHOLDER}
                className="text-fg placeholder:text-fg-subtle block min-h-[70vh] w-full resize-none bg-transparent font-mono text-[0.8125rem] leading-[1.85] outline-none [field-sizing:content]"
            />
          </div>
        </section>
        <section
          aria-label="Preview"
          className={cn('bg-bg-elevated/40 min-h-0 overflow-y-auto lg:block', pane === 'preview' ? 'block' : 'hidden')}
        >
          <div className="editor-pane-heading"><Eye size={14} aria-hidden /> Preview <span className="ml-auto font-normal normal-case tracking-normal">Updates as you type</span></div>
          <div className="px-4 py-6 md:px-8 md:py-8">
            <div className="subject-paper mx-auto min-h-[70vh] max-w-[48rem] p-5 md:p-8">
              {preview.trim() ? (
                <MarkdownView prose="writeup">{preview}</MarkdownView>
              ) : (
                <p className="writeup text-fg-subtle italic">Your write-up will appear here.</p>
              )}
            </div>
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
 * read — Newsreader, a comfortable measure and its own paper face.
 * "Edit" is always visible rather than a hover affordance,
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
    <section aria-labelledby="writeup-heading" className="subject-paper overflow-hidden">
      <div className="border-border flex min-h-16 items-center gap-3 border-b px-5 py-3 md:px-7">
        <BookOpen size={16} aria-hidden className="text-accent shrink-0" />
        <h2 id="writeup-heading" className="text-fg text-[0.8125rem] font-medium">
          Write-up
        </h2>
        {length ? <span className="text-fg-subtle hidden text-[0.6875rem] tabular-nums sm:inline">{length}</span> : null}
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
          {text.trim() ? 'Edit write-up' : 'Start writing'}
        </Button>
      </div>

      <div id="writeup-body" className="px-5 py-6 md:px-7 md:py-8">
        {text.trim() ? (
          <MarkdownView prose="writeup">{text}</MarkdownView>
        ) : (
          <button
            type="button"
            onClick={() => {
              setSeed('')
              setEditing(true)
            }}
            className="group flex min-h-56 w-full flex-col items-center justify-center gap-3 text-center"
          >
            <span className="bg-accent-subtle text-accent grid size-12 place-items-center rounded-2xl"><PenLine size={22} aria-hidden /></span>
            <span className="text-fg font-serif text-[1.375rem]">Every idea starts with a question.</span>
            <span className="text-fg-muted max-w-[32ch] text-[0.8125rem] leading-relaxed">What is it, why does it matter, and what would settle it?</span>
            <span className="text-accent mt-1 text-[0.75rem] font-medium group-hover:underline">Start your write-up →</span>
          </button>
        )}
      </div>

      {editing ? <Editor subjectRef={subjectRef} title={title} initial={seed} onClose={close} /> : null}
    </section>
  )
}

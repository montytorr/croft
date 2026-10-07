'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Code2, Download, ExternalLink, File, FileText, Film, Paperclip, Trash2, X } from 'lucide-react'
import type { Attachment } from '@/lib/lab/types'
import { mutate } from '@/lib/api/mutate'
import { useMutate } from '@/lib/api/use-mutate'
import { useNotify } from '@/components/toast'
import { cn } from '@/lib/utils'
import { COUNT, LABEL } from './styles'

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Shown as a tile with a preview; everything else is a row to download. */
const PREVIEWED = new Set<Attachment['kind']>(['image', 'html', 'video', 'pdf'])

/**
 * An HTML file, framed with an empty `sandbox`: no scripts, no same-origin, no
 * forms, popups or top navigation. /api/files serves it under a sandbox CSP as
 * well, so neither alone is what keeps it off Croft's origin. Never add an
 * allowance here.
 */
const SandboxedFrame = ({ src, title, className }: { src: string; title: string; className?: string }) => (
  <iframe
    src={src}
    title={title}
    sandbox=""
    referrerPolicy="no-referrer"
    loading="lazy"
    className={cn('bg-white', className)}
  />
)

const KindIcon = ({ kind, size = 13 }: { kind: Attachment['kind']; size?: number }) =>
  kind === 'html' ? (
    <Code2 size={size} aria-hidden />
  ) : kind === 'pdf' ? (
    <FileText size={size} aria-hidden />
  ) : kind === 'video' ? (
    <Film size={size} aria-hidden />
  ) : (
    <File size={size} aria-hidden />
  )

const ACTION =
  'grid size-[1.375rem] shrink-0 place-items-center rounded transition-[opacity,color,background-color] duration-[var(--dur-1)]'

/** The file opened large: an image, the sandboxed page, the PDF, the video. */
const Viewer = ({
  file,
  onClose,
  onDownload,
}: {
  file: Attachment
  onClose: () => void
  onDownload: () => void
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  const framed = file.kind === 'html' || file.kind === 'pdf'

  return (
    <div
      className="scrim fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 p-3 sm:p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={file.filename}
    >
      <div
        className="bg-surface border-border raised flex w-full max-w-[80rem] items-center gap-2 rounded-lg border px-2.5 py-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-fg-subtle"><KindIcon kind={file.kind} /></span>
        <span className="text-fg min-w-0 flex-1 truncate text-ui">{file.filename}</span>
        {file.kind === 'html' ? (
          <span className="text-fg-subtle hidden text-aux sm:inline" title="Framed with no scripts and no access to Croft">
            sandboxed · scripts off
          </span>
        ) : null}
        <a
          href={file.content_url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(ACTION, 'text-fg-subtle hover:text-fg hover:bg-surface-hover')}
          aria-label="Open in a new tab"
          title="Open in a new tab"
        >
          <ExternalLink size={13} />
        </a>
        <button type="button" onClick={onDownload} className={cn(ACTION, 'text-fg-subtle hover:text-fg hover:bg-surface-hover')} aria-label={`Download ${file.filename}`}>
          <Download size={13} />
        </button>
        <button type="button" onClick={onClose} className={cn(ACTION, 'text-fg-subtle hover:text-fg hover:bg-surface-hover')} aria-label="Close">
          <X size={14} />
        </button>
      </div>

      <div
        className={cn('enter-sheet flex min-h-0 w-full max-w-[80rem] justify-center', framed && 'flex-1')}
        onClick={(e) => e.stopPropagation()}
      >
        {file.kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={file.content_url} alt={file.filename} className="raised-lg max-h-[85dvh] max-w-full rounded-lg object-contain" />
        ) : file.kind === 'html' ? (
          <SandboxedFrame src={file.content_url} title={file.filename} className="raised-lg h-full w-full rounded-lg" />
        ) : file.kind === 'pdf' ? (
          // Not sandboxed: the browser's PDF viewer refuses a sandboxed
          // frame, and runs in its own process rather than on this origin.
          // /api/files serves it as application/pdf with nosniff, so nothing
          // uploaded as a PDF can be read as a page.
          <iframe
            src={file.content_url}
            title={file.filename}
            data-kind="pdf"
            referrerPolicy="no-referrer"
            className="raised-lg h-full w-full rounded-lg bg-white"
          />
        ) : file.kind === 'video' ? (
          <video src={file.content_url} controls autoPlay className="raised-lg max-h-[85dvh] max-w-full rounded-lg" />
        ) : null}
      </div>
    </div>
  )
}

/** A tile: what the file looks like, then its name. Clicking opens it large. */
const Tile = ({
  file,
  onOpen,
  onDownload,
  onRemove,
}: {
  file: Attachment
  onOpen: () => void
  onDownload: () => void
  onRemove: () => void
}) => (
  <li className="surface-card group relative flex min-w-0 flex-col overflow-hidden">
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${file.filename}`}
      className="bg-surface-raised relative block aspect-[4/3] w-full overflow-hidden"
    >
      {file.kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={file.content_url}
          alt=""
          loading="lazy"
          className="size-full object-cover transition-transform duration-[var(--dur-3)] ease-[var(--ease-out)] group-hover:scale-[1.02]"
        />
      ) : file.kind === 'html' ? (
        // A page at half scale: the frame is drawn twice the tile's size and
        // shrunk, so the thumbnail shows the layout, not its top-left corner.
        // It takes no pointer events; the tile's button is what opens it.
        <span className="pointer-events-none absolute inset-0 block">
          <SandboxedFrame
            src={file.content_url}
            title={`Preview of ${file.filename}`}
            className="h-[200%] w-[200%] origin-top-left scale-50 border-0"
          />
        </span>
      ) : file.kind === 'video' ? (
        <video src={file.content_url} preload="metadata" muted className="pointer-events-none size-full object-cover" />
      ) : (
        <span className="text-fg-subtle grid size-full place-items-center">
          <KindIcon kind={file.kind} size={22} />
        </span>
      )}
      {file.kind !== 'image' ? (
        <span className="bg-surface/90 text-fg-muted border-border absolute top-1.5 left-1.5 inline-flex h-[1.125rem] items-center gap-1 rounded border px-1 text-micro font-medium tracking-[0.06em] uppercase">
          <KindIcon kind={file.kind} size={9} />
          {file.kind}
        </span>
      ) : null}
    </button>
    <span className="border-border flex min-w-0 items-center gap-1 border-t py-1 pr-1 pl-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-fg min-w-0 truncate text-aux" title={file.filename}>{file.filename}</span>
        <span className="text-fg-subtle tabular truncate text-aux">
          {formatBytes(file.size_bytes)} · {file.uploaded_by}
        </span>
      </span>
      <button
        type="button"
        onClick={onDownload}
        className={cn(ACTION, 'text-fg-subtle hover:text-fg hover:bg-surface-hover opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100')}
        aria-label={`Download ${file.filename}`}
      >
        <Download size={12} />
      </button>
      <button
        type="button"
        onClick={onRemove}
        className={cn(ACTION, 'text-fg-subtle hover:text-danger hover:bg-danger-subtle opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100')}
        aria-label={`Delete ${file.filename}`}
      >
        <Trash2 size={12} />
      </button>
    </span>
  </li>
)

export const AttachmentsPanel = ({
  taskId,
  attachments,
}: {
  taskId: string
  attachments: Attachment[]
}) => {
  const router = useRouter()
  const request = useMutate()
  const notify = useNotify()
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [open, setOpen] = useState<Attachment | null>(null)
  // Stable, because the viewer's key listener is subscribed against it.
  const close = useCallback(() => setOpen(null), [])

  const upload = async (files: File[]) => {
    if (files.length === 0) return
    setPending(files.length)
    setError(null)
    // One at a time, so a refusal names the file it was about.
    for (const file of files) {
      const form = new FormData()
      form.append('file', file)
      const result = await mutate(`/api/v1/tasks/${taskId}/attachments`, { method: 'POST', form })
      setPending((n) => n - 1)
      if (!result.ok) {
        // The API names the acceptable types, so show that rather than "failed".
        setError(files.length > 1 ? `${file.name}: ${result.error}` : result.error)
        break
      }
    }
    setPending(0)
    router.refresh()
  }

  /** Signed URLs are short-lived, so fetch a fresh download link on demand rather than trusting the page's. */
  const download = async (file: Attachment) => {
    const res = await fetch(`/api/v1/attachments/${file.id}`).catch(() => null)
    const payload = await res?.json().catch(() => null)
    const url = payload?.data?.downloadUrl ?? payload?.data?.download_url
    if (!payload?.success || !url) {
      notify(payload?.error ?? 'Could not download that file.')
      return
    }
    window.open(url, '_blank', 'noopener')
  }

  const remove = async (file: Attachment) => {
    // Unchecked, this refreshed either way, so a refused delete looked like a
    // file that simply refused to go.
    const result = await request(`/api/v1/attachments/${file.id}`, { method: 'DELETE' })
    if (result.ok) {
      if (open?.id === file.id) setOpen(null)
      router.refresh()
    }
  }

  const tiles = attachments.filter((a) => PREVIEWED.has(a.kind))
  const rows = attachments.filter((a) => !PREVIEWED.has(a.kind))

  return (
    <section
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void upload([...e.dataTransfer.files])
      }}
      className={cn(
        '-mx-2 rounded-lg px-2 outline-1 -outline-offset-1 outline-dashed',
        'transition-[outline-color,background-color] duration-[var(--dur-2)] ease-[var(--ease-out)]',
        dragging ? 'bg-accent-subtle outline-accent' : 'outline-transparent',
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <h2 className={cn(LABEL, 'flex items-center gap-2')}>
          Files
          <span className={COUNT}>{attachments.length}</span>
        </h2>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void upload([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={pending > 0}
          className="text-fg-subtle hover:text-fg disabled:text-fg-muted ml-auto inline-flex h-6 items-center gap-1.5 text-aux transition-colors duration-[var(--dur-1)]"
        >
          <Paperclip size={12} aria-hidden />
          {pending > 0 ? `Uploading${pending > 1 ? ` ${pending}` : ''}…` : dragging ? 'Drop to attach' : 'Attach'}
        </button>
      </div>

      {error && (
        <p className="enter-rise text-danger bg-danger-subtle mb-2 rounded-md px-2 py-1.5 text-aux">{error}</p>
      )}

      {attachments.length === 0 ? (
        <p className="text-fg-subtle pb-1 text-aux">
          Drop a screenshot, a PDF or an HTML report here. HTML is shown sandboxed, with scripts off.
        </p>
      ) : null}

      {tiles.length > 0 && (
        <ul className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {tiles.map((a) => (
            <Tile
              key={a.id}
              file={a}
              onOpen={() => setOpen(a)}
              onDownload={() => void download(a)}
              onRemove={() => void remove(a)}
            />
          ))}
        </ul>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col pb-1">
          {rows.map((a) => (
            <li key={a.id} className="row-hover group -mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1">
              <span className="bg-surface-raised text-fg-subtle grid size-[1.5rem] shrink-0 place-items-center rounded-md">
                <KindIcon kind={a.kind} size={12} />
              </span>
              <button
                type="button"
                onClick={() => void download(a)}
                className="hover:text-accent min-w-0 flex-1 truncate text-left text-aux transition-colors duration-[var(--dur-1)]"
                title={`Download ${a.filename}`}
              >
                {a.filename}
              </button>
              <span className="text-fg-subtle tabular hidden shrink-0 text-aux sm:inline">
                {formatBytes(a.size_bytes)} · {a.uploaded_by}
              </span>
              <button
                type="button"
                onClick={() => void remove(a)}
                className={cn(ACTION, 'text-fg-subtle hover:text-danger hover:bg-danger-subtle opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100')}
                aria-label={`Delete ${a.filename}`}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && <Viewer file={open} onClose={close} onDownload={() => void download(open)} />}
    </section>
  )
}

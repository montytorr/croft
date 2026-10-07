'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Code2, Download, File, FileText, Film, Paperclip, Trash2, Upload, X } from 'lucide-react'
import { RelativeTime } from '@/components/relative-time'
import { Button } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { useMutate } from '@/lib/api/use-mutate'
import { uploadSubjectFile } from '@/lib/editor/upload'
import type { Attachment } from '@/lib/lab/types'
import { cn } from '@/lib/utils'

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The URL a file is shown from: the stable one, which re-signs on every request, so a page left open for hours still works. */
const viewUrl = (file: Attachment) => file.content_url || file.preview_url

const extension = (name: string) => /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]?.toUpperCase() ?? 'FILE'

const KIND_ICON = { html: Code2, pdf: FileText, video: Film, other: File, image: File } as const

/** What the viewer can show; everything else downloads. */
const viewable = (file: Attachment) => file.kind !== 'other'

const Tile = ({ file, onOpen, onDelete }: { file: Attachment; onOpen: () => void; onDelete: () => void }) => {
  const Icon = KIND_ICON[file.kind] ?? File
  return (
    <li className="group/tile bg-surface border-border hover:border-border-strong relative flex min-w-0 flex-col overflow-hidden rounded-lg border transition-colors duration-[var(--dur-1)]">
      <button
        type="button"
        onClick={onOpen}
        aria-label={viewable(file) ? `Open ${file.filename}` : `Download ${file.filename}`}
        className="bg-bg-elevated relative grid aspect-[4/3] place-items-center overflow-hidden"
      >
        {file.kind === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={viewUrl(file)}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-[var(--dur-3)] ease-[var(--ease-out)] group-hover/tile:scale-[1.02]"
          />
        ) : (
          <span className="text-fg-subtle flex flex-col items-center gap-1.5">
            <Icon size={22} strokeWidth={1.5} aria-hidden />
            <span className="font-mono text-aux tracking-wide">{file.kind === 'html' ? 'HTML' : extension(file.filename)}</span>
          </span>
        )}
      </button>
      <div className="flex min-w-0 items-start gap-1 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="text-fg truncate text-aux" title={file.filename}>
            {file.filename}
          </p>
          <p className="text-fg-subtle flex min-w-0 gap-1 truncate text-aux">
            <span className="tabular shrink-0">{formatBytes(file.size_bytes)}</span>
            <span aria-hidden>·</span>
            <RelativeTime iso={file.created_at} className="shrink-0" />
            <span aria-hidden>·</span>
            <span className="truncate">{file.uploaded_by}</span>
          </p>
        </div>
      </div>
      <span className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 pointer-coarse:opacity-100 transition-opacity group-hover/tile:opacity-100 group-focus-within/tile:opacity-100">
        <a
          href={file.download_url}
          download={file.filename}
          aria-label={`Download ${file.filename}`}
          className="bg-surface/90 text-fg-muted hover:text-fg border-border grid size-6 place-items-center rounded border backdrop-blur-sm"
        >
          <Download size={12} aria-hidden />
        </a>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${file.filename}`}
          className="bg-surface/90 text-fg-muted hover:text-danger border-border grid size-6 place-items-center rounded border backdrop-blur-sm"
        >
          <Trash2 size={12} aria-hidden />
        </button>
      </span>
    </li>
  )
}

/**
 * The file in front of the page. An image is shown at its size; a PDF in the
 * browser's own viewer; a video with its controls. HTML is only ever shown in
 * a fully sandboxed frame — no scripts, no same-origin, no forms, no top
 * navigation — and the server sends it with a `sandbox` CSP as well, so even
 * opened on its own it cannot run on Croft's origin.
 */
const Viewer = ({ files, index, onIndex, onClose }: { files: Attachment[]; index: number; onIndex: (i: number) => void; onClose: () => void }) => {
  const file = files[index]
  const many = files.length > 1

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (!many) return
      if (e.key === 'ArrowRight') onIndex((index + 1) % files.length)
      if (e.key === 'ArrowLeft') onIndex((index - 1 + files.length) % files.length)
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [files.length, index, many, onClose, onIndex])

  if (!file) return null
  const framed = file.kind === 'html' || file.kind === 'pdf'

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={file.filename} className="scrim fixed inset-0 z-50 flex flex-col" onClick={onClose}>
      <header
        className="flex h-11 shrink-0 items-center gap-2 bg-[#161316]/80 px-3 text-[#f1ebe7] backdrop-blur-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1 truncate text-ui">{file.filename}</span>
        {file.kind === 'html' ? (
          <span className="rounded border border-white/20 px-1.5 text-micro tracking-wide text-white/70 uppercase" title="Scripts, forms and navigation are blocked">
            Sandboxed
          </span>
        ) : null}
        {many ? <span className="text-aux text-white/60 tabular-nums">{index + 1} / {files.length}</span> : null}
        <a href={file.download_url} download={file.filename} aria-label="Download" className="grid size-8 place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white">
          <Download size={15} aria-hidden />
        </a>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-md text-white/80 hover:bg-white/10 hover:text-white">
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-3 md:p-6">
        {many ? (
          <>
            <button
              type="button"
              aria-label="Previous"
              onClick={(e) => {
                e.stopPropagation()
                onIndex((index - 1 + files.length) % files.length)
              }}
              className="absolute left-2 z-10 grid size-9 place-items-center rounded-full bg-black/40 text-white hover:bg-black/60 md:left-4"
            >
              <ChevronLeft size={18} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next"
              onClick={(e) => {
                e.stopPropagation()
                onIndex((index + 1) % files.length)
              }}
              className="absolute right-2 z-10 grid size-9 place-items-center rounded-full bg-black/40 text-white hover:bg-black/60 md:right-4"
            >
              <ChevronRight size={18} aria-hidden />
            </button>
          </>
        ) : null}
        <div key={file.id} className={cn(framed ? 'enter-sheet size-full max-w-[72rem]' : 'contents')} onClick={(e) => e.stopPropagation()}>
          {file.kind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={viewUrl(file)} alt={file.filename} className="enter-sheet raised-lg max-h-full max-w-full rounded-md object-contain" />
          ) : file.kind === 'video' ? (
            <video src={viewUrl(file)} controls autoPlay playsInline className="enter-sheet raised-lg max-h-full max-w-full rounded-md bg-black" />
          ) : file.kind === 'html' ? (
            <iframe
              src={viewUrl(file)}
              title={file.filename}
              sandbox=""
              referrerPolicy="no-referrer"
              className="raised-lg size-full rounded-md border-0 bg-white"
            />
          ) : file.kind === 'pdf' ? (
            <iframe src={viewUrl(file)} title={file.filename} className="raised-lg size-full rounded-md border-0 bg-white" />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * A subject's files: screenshots, exports, a prototype saved as HTML. Drop
 * them anywhere on the section or choose them; images show as thumbnails
 * and open in a lightbox, PDFs and videos play in place, HTML is previewed
 * sandboxed, anything else downloads.
 */
export const FilesPanel = ({ subjectRef, files: initial }: { subjectRef: string; files: Attachment[] }) => {
  const router = useRouter()
  const request = useMutate()
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState(initial)
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setFiles(initial)
  }
  const [uploading, setUploading] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [open, setOpen] = useState<number | null>(null)

  const upload = async (list: FileList | File[]) => {
    const picked = Array.from(list)
    if (!picked.length) return
    setErrors([])
    setUploading((n) => n + picked.length)
    for (const file of picked) {
      const result = await uploadSubjectFile(subjectRef, file)
      setUploading((n) => n - 1)
      if (result.ok) setFiles((current) => [...current.filter((f) => f.id !== result.data.id), result.data])
      else setErrors((current) => [...current, `${file.name}: ${result.error}`])
    }
    router.refresh()
  }

  const remove = async (file: Attachment) => {
    if (!window.confirm(`Delete ${file.filename}? A write-up that embeds it will show a broken image.`)) return
    const result = await request(`/api/v1/subjects/${subjectRef}/attachments/${file.id}`, { method: 'DELETE' })
    if (!result.ok) return
    setFiles((current) => current.filter((f) => f.id !== file.id))
    router.refresh()
  }

  const shown = files.filter(viewable)
  const close = useCallback(() => setOpen(null), [])
  const openFile = (file: Attachment) => {
    if (!viewable(file)) {
      window.open(file.download_url, '_blank', 'noopener')
      return
    }
    setOpen(shown.findIndex((f) => f.id === file.id))
  }

  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragging(false)
        void upload(e.dataTransfer.files)
      }}
      className={cn(
        'relative flex min-h-[16rem] flex-col gap-3 rounded-lg outline-1 -outline-offset-1 outline-dashed transition-[outline-color,background-color] duration-[var(--dur-2)]',
        dragging ? 'bg-accent-subtle/60 outline-accent' : 'outline-transparent',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void upload(e.target.files)
            e.target.value = ''
          }}
        />
        <Button size="sm" variant="secondary" onClick={() => input.current?.click()}>
          <Upload size={13} aria-hidden /> Upload
        </Button>
        <p className="text-fg-subtle text-aux">
          or drop files here. Images, PDFs, video, HTML and documents; an image pasted into the write-up lands here too.
        </p>
        {uploading > 0 ? (
          <span className="text-fg-muted ml-auto flex items-center gap-1.5 text-aux">
            <Spinner size={12} /> Uploading {uploading}…
          </span>
        ) : null}
      </div>

      {errors.length ? (
        <ul className="enter-rise text-danger bg-danger-subtle flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-aux" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      {files.length === 0 ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="border-border-strong bg-surface text-fg-muted hover:text-fg hover:border-fg-subtle flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border py-12 text-ui transition-colors"
        >
          <Paperclip size={18} strokeWidth={1.5} aria-hidden />
          No files yet. Drop screenshots, exports or a prototype here.
        </button>
      ) : (
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]">
          {files.map((file) => (
            <Tile key={file.id} file={file} onOpen={() => openFile(file)} onDelete={() => void remove(file)} />
          ))}
        </ul>
      )}

      {dragging ? (
        <p className="text-accent pointer-events-none absolute inset-x-0 bottom-3 text-center text-ui font-medium">
          Drop to add to this subject
        </p>
      ) : null}

      {open !== null ? <Viewer files={shown} index={open} onIndex={setOpen} onClose={close} /> : null}
    </div>
  )
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, posix, resolve } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'

export const MAX_BYTES = Number(process.env.CROFT_ATTACHMENT_MAX_BYTES || 10_485_760)
const attachmentRoot = () => resolve(/* turbopackIgnore: true */ process.env.CROFT_ATTACHMENT_DIR || '/data/attachments')
const signingKey = () => {
  const key = process.env.CROFT_ATTACHMENT_SIGNING_KEY
  if (!key) throw new Error('CROFT_ATTACHMENT_SIGNING_KEY is required')
  return key
}

const absolutePath = (storagePath: string) => {
  const root = attachmentRoot()
  const target = resolve(/* turbopackIgnore: true */ root, storagePath)
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error('Invalid attachment path')
  return target
}

/** Allowlist, because a denylist on uploads is a game you lose eventually. */
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Reports and prototypes. Only ever rendered sandboxed: /api/files serves it
  // under `Content-Security-Policy: sandbox`, and the UI frames it without
  // allow-scripts, so it can never run script on Croft's origin.
  'text/html',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'video/mp4',
  'audio/mpeg',
])

/**
 * Belt and braces alongside the MIME allowlist. A file can arrive with an
 * innocuous content-type and an executable extension, and the extension is
 * what a human's OS will act on after they download it.
 */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'com', 'ps1',
  'js', 'mjs', 'cjs', 'py', 'rb', 'pl', 'php', 'jar', 'app', 'scpt', 'vbs', 'msi',
])

export const sanitizeFilename = (name: string): string => {
  const base = name.split(/[/\\]/).pop() ?? 'file'
  return (
    base
      .replace(/[^\w.\-]+/g, '-')
      .replace(/^[.\-]+/, '')
      .slice(0, 120) || 'file'
  )
}

const extensionOf = (name: string): string => {
  const parts = name.toLowerCase().split('.')
  return parts.length > 1 ? (parts.pop() ?? '') : ''
}

export type Rejection = { reason: string; valid?: string[] }

export const validateUpload = (file: {
  name: string
  type: string
  size: number
}): Rejection | null => {
  if (file.size > MAX_BYTES) {
    return { reason: `File is ${file.size} bytes; the limit is ${MAX_BYTES}.` }
  }
  if (file.size === 0) return { reason: 'File is empty.' }

  const ext = extensionOf(file.name)
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { reason: `The .${ext} extension is not allowed.` }
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return { reason: `Content type ${file.type || '(none)'} is not allowed.`, valid: [...ALLOWED_MIME] }
  }
  return null
}

/** What a type-less upload most likely is, by extension. The CLI sends the same map. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', html: 'text/html', htm: 'text/html', pdf: 'application/pdf',
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip', mp4: 'video/mp4', mp3: 'audio/mpeg',
}

/**
 * The type an upload is stored and served as. Parameters are dropped
 * (`text/html; charset=utf-8` is text/html), and a file sent with no type or
 * as a bare octet-stream — some browsers do that for `.htm` — is read by its
 * extension. A declared type is never overridden: a `.html` sent as
 * text/plain stays text/plain, which is the safer of the two.
 */
export const effectiveMimeType = (name: string, type: string): string => {
  const declared = type.toLowerCase().split(';')[0]!.trim()
  if (declared && declared !== 'application/octet-stream') return declared
  return MIME_BY_EXTENSION[extensionOf(name)] ?? declared
}

/**
 * Types a browser would execute script in if the file were opened directly:
 * HTML, and SVG (which can carry `<script>`). /api/files serves these under a
 * sandbox CSP with no allowances, so the document gets an opaque origin and
 * no script at all, however it is reached.
 */
export const ACTIVE_CONTENT_MIME = new Set(['text/html', 'image/svg+xml'])

export const isActiveContent = (mimeType: string) => ACTIVE_CONTENT_MIME.has(mimeType.toLowerCase().split(';')[0]!.trim())

/**
 * Types that render as media and never as a document that could run script.
 * Everything else /api/files serves sandboxed — HTML and SVG above all, but
 * also any type nobody thought of yet. PDF is here because Chrome's viewer
 * refuses to open in a sandboxed document; it runs in its own process, not
 * on Croft's origin.
 */
const INERT_MIME = /^(?:image\/(?:png|jpeg|gif|webp)|application\/pdf|video\/[\w.+-]+|audio\/[\w.+-]+)$/

/**
 * Headers every served file carries. `sandbox` with no allowances gives the
 * document an opaque origin and no script, forms, popups or top navigation —
 * whether it is opened directly, framed without a sandbox attribute, or
 * framed by a page that got its attribute wrong.
 */
export const servedFileHeaders = (mimeType: string): Record<string, string> => {
  const mime = mimeType.toLowerCase().split(';')[0]!.trim()
  const headers: Record<string, string> = {
    'content-type': mimeType,
    'x-content-type-options': 'nosniff',
    // Framed by Croft's own pages (the HTML and PDF previews), nobody else's.
    'x-frame-options': 'SAMEORIGIN',
  }
  if (isActiveContent(mime) || !INERT_MIME.test(mime)) headers['content-security-policy'] = 'sandbox'
  return headers
}

export type AttachmentKind = 'image' | 'html' | 'pdf' | 'video' | 'other'

/** How the UI may show a file: inline image, sandboxed iframe, PDF/video player, or download. */
export const attachmentKind = (mimeType: string): AttachmentKind => {
  const mime = mimeType.toLowerCase().split(';')[0]!.trim()
  if (mime === 'text/html') return 'html'
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('video/')) return 'video'
  return 'other'
}

/** The stable, session-authenticated address markdown embeds: it redirects to a fresh signed URL. */
export const attachmentContentUrl = (id: string) => `/api/v1/attachments/${id}/content`

/** `{projectId}/tasks/{taskId}/{uuid}-{name}` — collision-free and browsable. */
export const buildStoragePath = (projectId: string, taskId: string, filename: string) =>
  `${projectId}/tasks/${taskId}/${crypto.randomUUID()}-${sanitizeFilename(filename)}`

/** `subjects/{subjectId}/{uuid}-{name}`: a subject has no task project to live under. */
export const buildSubjectStoragePath = (subjectId: string, filename: string) =>
  `subjects/${subjectId}/${crypto.randomUUID()}-${sanitizeFilename(filename)}`

export const sha256 = (buffer: Buffer | Uint8Array): string =>
  createHash('sha256').update(buffer).digest('hex')

/**
 * Two URLs, because they are used differently: `preview` renders inline in the
 * task view, `download` forces a save. Both expire in an hour — long enough for
 * a page session, short enough that a leaked link is not a standing grant.
 */
export const signUrls = async (storagePath: string, originalName: string, mimeType = 'application/octet-stream') => {
  const expires = Math.floor(Date.now() / 1000) + 3600
  const make = (download: boolean) => {
    const value = `${storagePath}\n${expires}\n${download ? originalName : ''}\n${mimeType}`
    const signature = createHmac('sha256', signingKey()).update(value).digest('base64url')
    const query = new URLSearchParams({ path: storagePath, expires: String(expires), mime: mimeType, signature })
    if (download) query.set('download', originalName)
    return `/api/files?${query}`
  }
  return {
    previewUrl: make(false),
    downloadUrl: make(true),
  }
}

/**
 * A stored row as the API and pages hand it out: the lab's `Attachment`
 * shape, with fresh signed URLs and the stable `content_url`.
 */
export const toAttachment = async (row: {
  id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  storage_path: string
  uploaded_by: string
  created_at: string
}) => {
  const { previewUrl, downloadUrl } = await signUrls(row.storage_path, row.filename, row.mime_type)
  return {
    id: row.id,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: Number(row.size_bytes),
    preview_url: previewUrl,
    download_url: downloadUrl,
    content_url: attachmentContentUrl(row.id),
    kind: attachmentKind(row.mime_type),
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  }
}

export const verifyAttachmentToken = (storagePath: string, expires: number, download: string, mimeType: string) => {
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return () => false
  const value = `${storagePath}\n${expires}\n${download}\n${mimeType}`
  return (signature: string) => {
    const expected = createHmac('sha256', signingKey()).update(value).digest()
    const supplied = Buffer.from(signature, 'base64url')
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }
}

/**
 * Where the bytes live: a directory by default, or an S3 bucket when
 * CROFT_ATTACHMENT_S3_BUCKET is set — for a platform whose containers have no
 * persistent disk (App Runner, Fargate without EFS). Either way the app serves
 * the file itself through the signed /api/files route, so a bucket stays
 * private and nothing about access changes. Credentials come from the
 * platform's role through the SDK's default chain; there is no key setting.
 *
 * The storage path is the same string in both, so a store can move between
 * them by copying files to keys.
 */
// `_S3_` on purpose. CROFT_ATTACHMENT_BUCKET was the Supabase storage bucket
// in .env.example until 2026-09-11 (`=attachments`), so every install older
// than that still carries it, and reading it switched those installs to S3 —
// where they have no bucket, no region and no credentials (CROFT-303).
const attachmentBucket = () => process.env.CROFT_ATTACHMENT_S3_BUCKET?.trim() || null
const objectKey = (storagePath: string) => {
  const key = posix.normalize(storagePath)
  if (key.startsWith('/') || key === '..' || key.startsWith('../')) throw new Error('Invalid attachment path')
  const prefix = process.env.CROFT_ATTACHMENT_S3_PREFIX?.replace(/^\/+|\/+$/g, '')
  return prefix ? `${prefix}/${key}` : key
}

let client: Promise<{ s3: S3Client; sdk: typeof import('@aws-sdk/client-s3') }> | null = null
// Loaded on first use, so a filesystem deployment never pays for the SDK. The
// region is passed rather than left to the SDK: not every container platform
// sets AWS_REGION, and without it the first upload fails, not the start-up.
const s3 = () => (client ??= import('@aws-sdk/client-s3').then((sdk) => ({
  sdk,
  s3: new sdk.S3Client({
    region: process.env.CROFT_ATTACHMENT_S3_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
  }),
})))

export const writeAttachment = async (storagePath: string, bytes: Buffer) => {
  const bucket = attachmentBucket()
  if (bucket) {
    const { sdk, s3: c } = await s3()
    // IfNoneMatch is the bucket's `flag: 'wx'`: an upload never replaces a file.
    await c.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: objectKey(storagePath), Body: bytes, IfNoneMatch: '*' }))
    return
  }
  const target = absolutePath(storagePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
}

export const readAttachment = async (storagePath: string): Promise<Buffer<ArrayBuffer>> => {
  const bucket = attachmentBucket()
  if (bucket) {
    const { sdk, s3: c } = await s3()
    const object = await c.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: objectKey(storagePath) }))
    if (!object.Body) throw new Error('Attachment not found')
    return Buffer.from(await object.Body.transformToByteArray())
  }
  return readFile(/* turbopackIgnore: true */ absolutePath(storagePath))
}

export const removeAttachments = async (paths: string[]) => {
  const bucket = attachmentBucket()
  if (bucket) {
    const { sdk, s3: c } = await s3()
    // Deleting a key that is not there succeeds, like the ENOENT below.
    await Promise.all(paths.map((path) => c.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: objectKey(path) }))))
    return
  }
  await Promise.all(paths.map((path) => unlink(/* turbopackIgnore: true */ absolutePath(path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })))
}

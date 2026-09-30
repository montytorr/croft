import { beforeEach, describe, expect, it } from 'vitest'
import { signUrls, verifyAttachmentToken } from './attachments'

describe('native attachment links', () => {
  beforeEach(() => {
    process.env.CROFT_ATTACHMENT_SIGNING_KEY = 'test-signing-key-with-enough-entropy'
  })

  it('signs preview and download intent separately', async () => {
    const links = await signUrls('project/tasks/task/file.pdf', 'report final.pdf', 'application/pdf')
    const preview = new URL(links.previewUrl, 'https://tasks.example.com')
    const download = new URL(links.downloadUrl, 'https://tasks.example.com')
    const valid = (url: URL) => verifyAttachmentToken(
      url.searchParams.get('path')!,
      Number(url.searchParams.get('expires')),
      url.searchParams.get('download') || '',
      url.searchParams.get('mime')!,
    )(url.searchParams.get('signature')!)
    expect(valid(preview)).toBe(true)
    expect(valid(download)).toBe(true)
    preview.searchParams.set('download', 'other.pdf')
    expect(valid(preview)).toBe(false)
  })
})

describe('what a file is, and how it may be shown', () => {
  it('derives the kind from the type: html is its own kind, never an image or a download', async () => {
    const { attachmentKind } = await import('./attachments')
    expect(attachmentKind('text/html')).toBe('html')
    expect(attachmentKind('text/html; charset=utf-8')).toBe('html')
    expect(attachmentKind('image/png')).toBe('image')
    expect(attachmentKind('image/svg+xml')).toBe('image')
    expect(attachmentKind('application/pdf')).toBe('pdf')
    expect(attachmentKind('video/mp4')).toBe('video')
    expect(attachmentKind('application/zip')).toBe('other')
    expect(attachmentKind('text/plain')).toBe('other')
  })

  it('accepts HTML by type, and reads a type-less .htm/.html by its extension', async () => {
    const { effectiveMimeType, validateUpload } = await import('./attachments')
    expect(validateUpload({ name: 'report.html', type: 'text/html', size: 10 })).toBeNull()
    expect(effectiveMimeType('report.htm', '')).toBe('text/html')
    expect(effectiveMimeType('report.html', 'application/octet-stream')).toBe('text/html')
    expect(effectiveMimeType('report.html', 'text/html; charset=UTF-8')).toBe('text/html')
    // A declared type is never upgraded to an active one.
    expect(effectiveMimeType('report.html', 'text/plain')).toBe('text/plain')
    expect(effectiveMimeType('blob', '')).toBe('')
    expect(validateUpload({ name: 'x.exe', type: 'text/html', size: 10 })?.reason).toMatch(/\.exe/)
    expect(validateUpload({ name: 'x.xhtml', type: 'application/xhtml+xml', size: 10 })?.reason).toMatch(/not allowed/)
  })

  it('serves HTML, SVG and anything not plainly media sandboxed; images, PDF and video render as they are', async () => {
    const { servedFileHeaders } = await import('./attachments')
    for (const mime of ['text/html', 'TEXT/HTML; charset=utf-8', 'image/svg+xml', 'text/plain', 'application/json', 'application/xhtml+xml']) {
      const headers = servedFileHeaders(mime)
      expect(headers['content-security-policy'], mime).toBe('sandbox')
      expect(headers['x-content-type-options']).toBe('nosniff')
    }
    for (const mime of ['image/png', 'image/jpeg', 'application/pdf', 'video/mp4', 'audio/mpeg']) {
      const headers = servedFileHeaders(mime)
      expect(headers['content-security-policy'], mime).toBeUndefined()
      expect(headers['x-content-type-options']).toBe('nosniff')
      expect(headers['x-frame-options']).toBe('SAMEORIGIN')
    }
  })

  it('gives every file a stable content_url beside its signed links', async () => {
    const { toAttachment } = await import('./attachments')
    const a = await toAttachment({
      id: '0b8f6a1e-0000-4000-8000-000000000001', filename: 'shot.png', mime_type: 'image/png', size_bytes: '42',
      storage_path: 'subjects/s/abc-shot.png', uploaded_by: 'cal', created_at: '2026-09-30T00:00:00.000Z',
    })
    expect(a).toMatchObject({
      filename: 'shot.png', kind: 'image', size_bytes: 42, uploaded_by: 'cal',
      content_url: '/api/v1/attachments/0b8f6a1e-0000-4000-8000-000000000001/content',
    })
    expect(a.preview_url).toMatch(/^\/api\/files\?/)
    expect(new URL(a.download_url, 'https://x.test').searchParams.get('download')).toBe('shot.png')
  })
})

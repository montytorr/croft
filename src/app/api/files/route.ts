import { NextResponse } from 'next/server'
import { readAttachment, servedFileHeaders, verifyAttachmentToken } from '@/lib/attachments'

export const GET = async (request: Request) => {
  const url = new URL(request.url)
  const path = url.searchParams.get('path') || ''
  const download = url.searchParams.get('download') || ''
  const mime = url.searchParams.get('mime') || 'application/octet-stream'
  const expires = Number(url.searchParams.get('expires'))
  const signature = url.searchParams.get('signature') || ''
  if (!path || !verifyAttachmentToken(path, expires, download, mime)(signature)) {
    return NextResponse.json({ error: 'Invalid or expired attachment link.' }, { status: 403 })
  }
  try {
    const bytes = await readAttachment(path)
    // HTML and SVG (and anything not plainly media) under `CSP: sandbox`, so a
    // file opened straight from its link can never run script on this origin.
    const headers = new Headers({ 'cache-control': 'private, max-age=300', ...servedFileHeaders(mime) })
    if (download) headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download)}`)
    return new NextResponse(bytes, { headers })
  } catch (error) {
    // Missing is the common case; anything else (a bucket permission, a
    // region, the network) would otherwise be indistinguishable from it.
    const missing = (error as { code?: string; name?: string })
    if (missing.code !== 'ENOENT' && missing.name !== 'NoSuchKey') {
      console.error(`attachment read failed for ${path}:`, error)
    }
    return NextResponse.json({ error: 'Attachment not found.' }, { status: 404 })
  }
}

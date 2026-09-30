import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The signed file route, end to end over a real directory store. The point
 * is the headers: an HTML report (or an SVG, which can carry script) opened
 * straight from its link must never run script on Croft's origin, so it is
 * served under `Content-Security-Policy: sandbox` with no allowances.
 */
let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'croft-files-'))
  process.env.CROFT_ATTACHMENT_DIR = dir
  process.env.CROFT_ATTACHMENT_SIGNING_KEY = 'test-signing-key-with-enough-entropy'
})

afterAll(async () => {
  delete process.env.CROFT_ATTACHMENT_DIR
  await rm(dir, { recursive: true, force: true })
})

const fetchSigned = async (name: string, mime: string, content: string, download = false) => {
  const { signUrls, writeAttachment } = await import('@/lib/attachments')
  const { GET } = await import('./route')
  const path = `subjects/s1/${crypto.randomUUID()}-${name}`
  await writeAttachment(path, Buffer.from(content))
  const { previewUrl, downloadUrl } = await signUrls(path, name, mime)
  return GET(new Request(`https://croft.example.test${download ? downloadUrl : previewUrl}`))
}

describe('/api/files', () => {
  it('serves HTML sandboxed: no scripts, no same-origin, never sniffed', async () => {
    const res = await fetchSigned('report.html', 'text/html', '<script>alert(document.cookie)</script><h1>hi</h1>')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
    const csp = res.headers.get('content-security-policy')
    expect(csp).toBe('sandbox')
    expect(csp).not.toMatch(/allow-scripts|allow-same-origin/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(await res.text()).toContain('<h1>hi</h1>')
  })

  it('serves SVG sandboxed too, previewed or downloaded', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    for (const download of [false, true]) {
      const res = await fetchSigned('x.svg', 'image/svg+xml', svg, download)
      expect(res.headers.get('content-security-policy')).toBe('sandbox')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('leaves a raster image and a PDF unsandboxed, so they still render', async () => {
    for (const [name, mime] of [['a.png', 'image/png'], ['a.pdf', 'application/pdf']]) {
      const res = await fetchSigned(name!, mime!, 'bytes')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toBeNull()
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('refuses a link whose type was changed after signing', async () => {
    const { signUrls, writeAttachment } = await import('@/lib/attachments')
    const { GET } = await import('./route')
    const path = `subjects/s1/${crypto.randomUUID()}-page.txt`
    await writeAttachment(path, Buffer.from('<script>1</script>'))
    const { previewUrl } = await signUrls(path, 'page.txt', 'text/plain')
    const forged = new URL(previewUrl, 'https://croft.example.test')
    forged.searchParams.set('mime', 'image/png')
    expect((await GET(new Request(forged))).status).toBe(403)
  })
})

describe('framing', () => {
  it('lets Croft frame its own files (HTML and PDF previews) while every other page stays DENY', async () => {
    const config = (await import('../../../../next.config')).default
    const rules = (await config.headers!()) as { source: string; headers: { key: string; value: string }[] }[]
    const frameOption = (path: string) =>
      rules
        .filter((r) => r.source === path || r.source === '/:path*')
        .flatMap((r) => r.headers)
        .filter((h) => h.key === 'X-Frame-Options')
        .at(-1)?.value
    // Next applies the last matching rule for a repeated key.
    expect(frameOption('/api/files')).toBe('SAMEORIGIN')
    expect(rules.find((r) => r.source === '/:path*')?.headers).toContainEqual({ key: 'X-Frame-Options', value: 'DENY' })
    expect(rules.findIndex((r) => r.source === '/api/files')).toBeGreaterThan(rules.findIndex((r) => r.source === '/:path*'))
  })
})

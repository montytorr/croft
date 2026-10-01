import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { escapeHtml, mailBaseUrl, mailConfigured, sendMail } from './mail'

const KEY = 're_unit_secret_key_value'
const message = { to: 'pat@example.test', subject: 'Reset', text: 'plain', html: '<p>html</p>' }

const configure = (extra: Record<string, string> = {}) => {
  vi.stubEnv('RESEND_API_KEY', KEY)
  vi.stubEnv('CROFT_MAIL_FROM', 'Croft <croft@montytorr.com>')
  vi.stubEnv('CROFT_BASE_URL', 'https://croft.example.test/')
  vi.stubEnv('CROFT_MAIL_REPLY_TO', '')
  for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value)
}

describe('mail', () => {
  const fetchMock = vi.fn()
  const errors = vi.spyOn(console, 'error')

  beforeEach(() => {
    fetchMock.mockReset()
    errors.mockReset().mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('is not configured without the key, the sender or the base URL, and then sends nothing', async () => {
    for (const missing of ['RESEND_API_KEY', 'CROFT_MAIL_FROM', 'CROFT_BASE_URL']) {
      configure({ [missing]: '' })
      expect(mailConfigured(), missing).toBe(false)
      const result = await sendMail(message)
      expect(result).toMatchObject({ ok: false, code: 'mail_not_configured' })
    }
    configure({ CROFT_BASE_URL: 'javascript:alert(1)' })
    expect(mailConfigured()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts to Resend with the bearer key and returns the message id', async () => {
    configure({ CROFT_MAIL_REPLY_TO: 'help@example.test' })
    expect(mailConfigured()).toBe(true)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 }))

    expect(await sendMail(message)).toEqual({ ok: true, id: 'msg_123' })

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body)).toEqual({
      from: 'Croft <croft@montytorr.com>',
      to: ['pat@example.test'],
      subject: 'Reset',
      text: 'plain',
      html: '<p>html</p>',
      reply_to: 'help@example.test',
    })
  })

  it('reads the sender verbatim, angle brackets and spaces included, and sends no reply_to when unset', async () => {
    configure()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }))
    await sendMail(message)
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.from).toBe('Croft <croft@montytorr.com>')
    expect(body).not.toHaveProperty('reply_to')
  })

  it('reports Resend’s error message, and never the key', async () => {
    configure()
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'The domain is not verified.' }), {
        status: 403,
      }),
    )
    const result = await sendMail(message)
    expect(result).toEqual({ ok: false, code: 'mail_send_failed', error: 'The domain is not verified.' })
    expect(errors).toHaveBeenCalled()
    expect(JSON.stringify(errors.mock.calls)).toContain('The domain is not verified.')
    expect(JSON.stringify(errors.mock.calls)).not.toContain(KEY)
  })

  it('fails closed on a network error, a timeout or an answer with no id', async () => {
    configure()
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed ${KEY}`))
    expect(await sendMail(message)).toMatchObject({ ok: false, code: 'mail_send_failed', error: 'Resend could not be reached.' })

    fetchMock.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    expect(await sendMail(message)).toMatchObject({ ok: false, code: 'mail_send_failed', error: expect.stringContaining('10s') })

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    expect(await sendMail(message)).toMatchObject({ ok: false, code: 'mail_send_failed' })

    expect(JSON.stringify(errors.mock.calls)).not.toContain(KEY)
  })

  it('builds links from CROFT_BASE_URL without a trailing slash', () => {
    configure({ CROFT_BASE_URL: 'https://croft.example.test/sub/' })
    expect(mailBaseUrl()).toBe('https://croft.example.test/sub')
  })

  it('escapes html', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })
})

/**
 * Outgoing email, through Resend's HTTP API (no SDK: one POST is the whole
 * integration). Croft sends exactly one kind of mail — a password reset link —
 * so this stays small on purpose.
 *
 * Configured by RESEND_API_KEY and CROFT_MAIL_FROM, with CROFT_MAIL_REPLY_TO
 * optional. CROFT_BASE_URL is required too, because every mail Croft sends
 * carries a link, and a link built from the request's Host header is the
 * classic password-reset poisoning hole: anyone could ask for a reset with a
 * forged host and have the victim's token delivered to their own domain.
 *
 * The key never leaves this file: it is not logged, not returned, and not
 * shown to the browser. Only Resend's own error message is logged.
 */

const RESEND_URL = 'https://api.resend.com/emails'
const TIMEOUT_MS = 10_000

export const MAIL_NOT_CONFIGURED =
  'Email is not set up on this Croft: set RESEND_API_KEY and CROFT_MAIL_FROM'

export type MailMessage = { to: string; subject: string; text: string; html: string }

export type MailResult =
  | { ok: true; id: string }
  | { ok: false; code: 'mail_not_configured' | 'mail_send_failed'; error: string }

const env = (name: string) => process.env[name]?.trim() || null

/** The public origin links in mail point to, or null when CROFT_BASE_URL is unset or not an http(s) URL. */
export const mailBaseUrl = (): string | null => {
  const raw = env('CROFT_BASE_URL')
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/** What is missing, in words for an administrator, or null when mail can be sent. */
export const mailConfigurationProblem = (): string | null => {
  if (!env('RESEND_API_KEY') || !env('CROFT_MAIL_FROM')) return `${MAIL_NOT_CONFIGURED}.`
  if (!mailBaseUrl()) return 'Email is not set up on this Croft: set CROFT_BASE_URL to the public URL, which builds the link.'
  return null
}

export const mailConfigured = (): boolean => mailConfigurationProblem() === null

const resendError = async (response: Response): Promise<string> => {
  const payload = (await response.json().catch(() => null)) as { message?: unknown; name?: unknown } | null
  const message = typeof payload?.message === 'string' ? payload.message : null
  return message ?? `Resend answered ${response.status}.`
}

export const sendMail = async ({ to, subject, text, html }: MailMessage): Promise<MailResult> => {
  const problem = mailConfigurationProblem()
  if (problem) return { ok: false, code: 'mail_not_configured', error: problem }
  const replyTo = env('CROFT_MAIL_REPLY_TO')
  try {
    const response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env('RESEND_API_KEY')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env('CROFT_MAIL_FROM'),
        to: [to],
        subject,
        text,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      const error = await resendError(response)
      console.error(`[mail] Resend refused the message (${response.status}): ${error}`)
      return { ok: false, code: 'mail_send_failed', error }
    }
    const payload = (await response.json().catch(() => null)) as { id?: unknown } | null
    if (typeof payload?.id !== 'string') {
      console.error('[mail] Resend accepted the message but returned no id')
      return { ok: false, code: 'mail_send_failed', error: 'Resend returned no message id.' }
    }
    return { ok: true, id: payload.id }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    const message = timedOut ? `Resend did not answer within ${TIMEOUT_MS / 1000}s.` : 'Resend could not be reached.'
    console.error(`[mail] ${message}`)
    return { ok: false, code: 'mail_send_failed', error: message }
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ESCAPES[char]!)

'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useTransition } from 'react'
import { ArrowLeft, Eye, EyeOff, MailCheck } from 'lucide-react'
import { Button, Input } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { useBrand } from '@/components/brand'
import { mutate, NETWORK_ERROR } from '@/lib/api/mutate'
import { AuthError, AuthShell } from './auth-shell'
// `?redirect=` comes from the URL bar, so it is attacker-controlled; this
// honours a same-site path only.
import { safeRedirect } from '@/lib/auth/login-redirect'

type Mode = 'sign-in' | 'forgot' | 'sent'

/** Refusals that are about the request, never about the address. */
const SHOWN_FORGOT_FAILURES = new Set(['rate_limited', 'validation_failed', 'mail_not_configured', 'forbidden'])

const LINK =
  'text-fg-subtle hover:text-fg rounded-sm text-aux transition-colors ' +
  'focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-2'

/**
 * `canReset` is the server's answer to "is email set up here?" — never the
 * key itself. Without email there is no way to deliver a reset link, so the
 * offer is not made at all rather than made and then broken.
 */
export const LoginForm = ({ canReset = false }: { canReset?: boolean }) => {
  const { name } = useBrand()
  const [mode, setMode] = useState<Mode>('sign-in')
  const [reveal, setReveal] = useState(false)
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  // The sign-in call is quick; rendering the first page is not. Without this
  // the button reverted to "Sign in" the instant the token arrived and then
  // nothing moved for a second or two, which reads exactly as broken.
  const [navigating, startNavigation] = useTransition()
  const busy = pending || navigating

  const switchTo = (next: Mode) => {
    setMode(next)
    setError(null)
    setPending(false)
  }

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)

    // Everything is inside try/catch so a thrown error surfaces instead of
    // leaving the button stuck on "Signing in…" forever — which is exactly
    // how the build-time-env bug presented, and made it far harder to read
    // than it needed to be.
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        setError(body?.error ?? 'Sign-in failed.')
        setPending(false)
        return
      }

      // Deliberately no setPending(false) on this path: the form stays busy
      // until the destination has actually rendered.
      startNavigation(() => {
        router.replace(safeRedirect(params.get('redirect')))
        router.refresh()
      })
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'Sign-in failed.')
      setPending(false)
    }
  }

  // The answer is the same whether or not the address has an account: the
  // server says `ok` either way, and so does this page. Only a failure that
  // says nothing about whether the address exists is shown.
  const onForgot = async (event: React.FormEvent) => {
    event.preventDefault()
    setPending(true)
    setError(null)
    const result = await mutate('/api/auth/forgot', { method: 'POST', body: { email: email.trim() } })
    setPending(false)
    if (!result.ok && (result.error === NETWORK_ERROR || SHOWN_FORGOT_FAILURES.has(result.code ?? ''))) {
      setError(result.error)
      return
    }
    setMode('sent')
  }

  if (mode === 'sent') {
    return (
      <AuthShell>
        <MailCheck size={22} className="text-fg-muted mb-4" aria-hidden />
        <h1 className="font-display headline text-fg text-[1.75rem] leading-tight">Check your email</h1>
        <p className="text-fg-muted mt-3 text-ui leading-relaxed" role="status">
          If <span className="text-fg font-medium break-all">{email.trim()}</span> belongs to an account on {name},
          a link to choose a new password is on its way. It works once, within the hour.
        </p>
        <p className="text-fg-subtle mt-3 text-aux leading-relaxed">
          Nothing arrived? Check the spam folder, or ask an administrator of this Croft to send you a reset link.
        </p>
        <button type="button" onClick={() => switchTo('sign-in')} className={`${LINK} mt-8 inline-flex items-center gap-1.5`}>
          <ArrowLeft size={13} aria-hidden /> Back to sign in
        </button>
      </AuthShell>
    )
  }

  if (mode === 'forgot') {
    return (
      <AuthShell>
        <h1 className="font-display headline text-fg text-[1.75rem] leading-tight">Forgot your password?</h1>
        <p className="text-fg-muted mt-2 text-ui leading-relaxed">
          Enter the email you sign in with. We’ll send a link to choose a new one.
        </p>

        <form onSubmit={onForgot} className="mt-8 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-fg-muted text-aux font-medium">Email</span>
            <Input
              type="email"
              required
              autoFocus
              autoComplete="username"
              disabled={pending}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          {error ? <AuthError>{error}</AuthError> : null}

          <Button type="submit" variant="primary" disabled={pending} className="mt-2">
            {pending ? (
              <span className="inline-flex items-center gap-2">
                <Spinner />
                Sending…
              </span>
            ) : (
              'Send reset link'
            )}
          </Button>
        </form>

        <button type="button" onClick={() => switchTo('sign-in')} className={`${LINK} mt-6 inline-flex items-center gap-1.5`}>
          <ArrowLeft size={13} aria-hidden /> Back to sign in
        </button>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1 className="font-display headline text-fg text-[1.75rem] leading-tight">Welcome back</h1>
      <p className="text-fg-muted mt-2 text-ui">Sign in to {name}.</p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-fg-muted text-aux font-medium">Email</span>
          <Input
            type="email"
            required
            autoFocus
            autoComplete="username"
            disabled={busy}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-fg-muted text-aux font-medium">Password</span>
            <span className="relative flex">
              <Input
                type={reveal ? 'text' : 'password'}
                required
                autoComplete="current-password"
                disabled={busy}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9 pr-9"
              />
              <button
                type="button"
                onClick={() => setReveal((shown) => !shown)}
                aria-label={reveal ? 'Hide password' : 'Show password'}
                aria-pressed={reveal}
                className="text-fg-subtle hover:text-fg absolute inset-y-0 right-0 grid w-9 place-items-center transition-colors"
              >
                {reveal ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
              </button>
            </span>
          </label>
          {canReset ? (
            <button type="button" onClick={() => switchTo('forgot')} disabled={busy} className={`${LINK} self-end`}>
              Forgot your password?
            </button>
          ) : null}
        </div>

        {error ? <AuthError>{error}</AuthError> : null}

        <Button type="submit" variant="primary" disabled={busy} className="mt-2">
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Spinner />
              {navigating ? 'Opening the lab…' : 'Signing in…'}
            </span>
          ) : (
            'Sign in'
          )}
        </Button>
      </form>

      {/* Who can come in, and how agents do: the two questions the old
          "single-user" line answered wrongly once admins could add people. */}
      <div className="border-border text-fg-subtle mt-10 flex flex-col gap-2 border-t pt-5 text-aux leading-relaxed">
        <p>No account yet? An administrator of this Croft can add you.</p>
        <p>
          Agents don’t sign in here. They connect with an API key, which{' '}
          <code className="font-mono">croft setup</code> pairs from your machine.
        </p>
      </div>
    </AuthShell>
  )
}

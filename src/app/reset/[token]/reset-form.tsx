'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ArrowLeft, CircleCheck, Eye, EyeOff, LinkIcon } from 'lucide-react'
import { Button, Input } from '@/components/ui/control'
import { Spinner } from '@/components/spinner'
import { useBrand } from '@/components/brand'
import { mutate, NETWORK_ERROR } from '@/lib/api/mutate'
import { AuthError, AuthShell } from '@/app/login/auth-shell'

const MIN_PASSWORD = 12

type State = 'idle' | 'saving' | 'done' | 'invalid'

const LINK =
  'text-fg-subtle hover:text-fg rounded-sm text-aux transition-colors ' +
  'focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-2'

const PRIMARY_LINK =
  'bg-accent text-accent-fg inline-flex h-9 items-center justify-center rounded-md px-4 text-ui font-medium ' +
  'transition-[filter] hover:brightness-110 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-2'

/**
 * A failure that says something about the request rather than the link: the
 * connection dropped, too many tries, the password itself was refused, or the
 * request came from somewhere else. Everything else — unknown, used, expired
 * (`invalid_token`) — is the same dead link.
 */
const ABOUT_THE_REQUEST = new Set(['rate_limited', 'validation_failed', 'forbidden'])

const isAboutTheRequest = (result: { error: string; code?: string }) =>
  result.error === NETWORK_ERROR || ABOUT_THE_REQUEST.has(result.code ?? '')

export const ResetForm = ({ token }: { token: string }) => {
  const { name } = useBrand()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [reveal, setReveal] = useState(false)
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState<string | null>(null)

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD
  const mismatch = confirm.length > 0 && password !== confirm
  const canSubmit = password.length >= MIN_PASSWORD && password === confirm && state === 'idle'

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setState('saving')
    setError(null)
    const result = await mutate('/api/auth/reset', { method: 'POST', body: { token, password } })
    if (result.ok) {
      setPassword('')
      setConfirm('')
      setState('done')
      return
    }
    if (isAboutTheRequest(result)) {
      setError(result.error)
      setState('idle')
      return
    }
    setState('invalid')
  }

  if (state === 'done') {
    return (
      <AuthShell>
        <CircleCheck size={22} className="text-status-in-review mb-4" aria-hidden />
        <h1 className="font-display headline text-fg text-[1.75rem] leading-tight">Password changed</h1>
        <p className="text-fg-muted mt-3 text-ui leading-relaxed" role="status">
          Every session that was signed in to {name} as you has been signed out. Sign in with the new password.
        </p>
        <Link href="/login" className={`${PRIMARY_LINK} mt-8 w-full`}>
          Sign in
        </Link>
      </AuthShell>
    )
  }

  if (state === 'invalid') {
    return (
      <AuthShell>
        <LinkIcon size={22} className="text-fg-muted mb-4" aria-hidden />
        <h1 className="font-display headline text-fg text-[1.75rem] leading-tight">This link no longer works</h1>
        <p className="text-fg-muted mt-3 text-ui leading-relaxed" role="alert">
          A reset link works once, within an hour of being sent, and only the newest one does. Ask for a new
          one from the sign-in page, or ask an administrator of this Croft to send it.
        </p>
        <Link href="/login" className={`${LINK} mt-8 inline-flex items-center gap-1.5`}>
          <ArrowLeft size={13} aria-hidden /> Back to sign in
        </Link>
      </AuthShell>
    )
  }

  const saving = state === 'saving'

  return (
    <AuthShell>
      <h1 className="font-display headline text-fg text-[1.75rem] leading-tight">Choose a new password</h1>
      <p className="text-fg-muted mt-2 text-ui leading-relaxed">
        At least {MIN_PASSWORD} characters. Setting it signs this account out everywhere it is signed in.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-fg-muted text-aux font-medium">New password</span>
          <span className="relative flex">
            <Input
              type={reveal ? 'text' : 'password'}
              name="password"
              required
              autoFocus
              minLength={MIN_PASSWORD}
              autoComplete="new-password"
              disabled={saving}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={tooShort}
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
          {tooShort ? (
            <span className="text-fg-subtle text-aux">
              {MIN_PASSWORD - password.length} more character{MIN_PASSWORD - password.length === 1 ? '' : 's'}.
            </span>
          ) : null}
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-fg-muted text-aux font-medium">Confirm</span>
          <Input
            type={reveal ? 'text' : 'password'}
            name="confirm"
            required
            autoComplete="new-password"
            disabled={saving}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch}
            className="h-9"
          />
          {mismatch ? <span className="text-danger text-aux">The two don’t match.</span> : null}
        </label>

        {error ? <AuthError>{error}</AuthError> : null}

        <Button type="submit" variant="primary" disabled={!canSubmit} className="mt-2 h-9">
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <Spinner />
              Saving…
            </span>
          ) : (
            'Set password'
          )}
        </Button>
      </form>

      <Link href="/login" className={`${LINK} mt-6 inline-flex items-center gap-1.5`}>
        <ArrowLeft size={13} aria-hidden /> Back to sign in
      </Link>
    </AuthShell>
  )
}

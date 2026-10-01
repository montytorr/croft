import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResetForm } from './reset-form'

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }))

vi.mock('@/lib/api/mutate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/mutate')>()),
  mutate: mutateMock,
}))

const GOOD = 'a long enough password'

describe('ResetForm', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const input = (name: string) => container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!
  const type = async (field: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const fill = async (password: string, confirm = password) => {
    await type(input('password'), password)
    await type(input('confirm'), confirm)
  }
  const submit = async () => {
    await act(async () => {
      container.querySelector('form')!.requestSubmit()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mutateMock.mockReset().mockResolvedValue({ ok: true, data: {} })
    await act(async () => root.render(<ResetForm token="tok_123" />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('asks for a password and its confirmation, at least 12 characters', async () => {
    expect(container.querySelector('h1')?.textContent).toBe('Choose a new password')
    expect(input('password').minLength).toBe(12)
    expect(submitButton().disabled).toBe(true)

    await fill('short')
    expect(container.textContent).toContain('7 more characters.')
    expect(submitButton().disabled).toBe(true)

    await fill(GOOD, `${GOOD}!`)
    expect(container.textContent).toContain('The two don’t match.')
    expect(submitButton().disabled).toBe(true)

    await fill(GOOD)
    expect(submitButton().disabled).toBe(false)
  })

  it('sends the token with the password, then points to sign in', async () => {
    await fill(GOOD)
    await submit()
    expect(mutateMock).toHaveBeenCalledWith('/api/auth/reset', { method: 'POST', body: { token: 'tok_123', password: GOOD } })
    expect(container.querySelector('h1')?.textContent).toBe('Password changed')
    expect(container.querySelector('input')).toBeNull()
    const signIn = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Sign in')
    expect(signIn?.getAttribute('href')).toBe('/login')
  })

  it.each([
    ['unknown', { ok: false, error: 'Unknown token', code: 'not_found' }],
    ['used', { ok: false, error: 'This reset link is invalid or has expired.', code: 'invalid_token' }],
    ['expired', { ok: false, error: 'Token expired', code: 'bad_request' }],
  ])('says the same thing for an %s link, and nothing the server said', async (_case, failure) => {
    mutateMock.mockResolvedValue(failure)
    await fill(GOOD)
    await submit()
    expect(container.querySelector('h1')?.textContent).toBe('This link no longer works')
    expect(container.textContent).not.toContain(failure.error)
    expect(container.querySelector('input')).toBeNull()
  })

  it('shows the server refusing the password, and keeps the form', async () => {
    mutateMock.mockResolvedValue({ ok: false, error: 'Password must be at least 12 characters.', code: 'validation_failed' })
    await fill(GOOD)
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Password must be at least 12 characters.')
    expect(container.querySelector('h1')?.textContent).toBe('Choose a new password')
  })

  it('keeps the form for a failure that is not about the link', async () => {
    mutateMock.mockResolvedValue({ ok: false, error: 'Too many requests. Retry in 60s.', code: 'rate_limited' })
    await fill(GOOD)
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Too many requests. Retry in 60s.')
    expect(container.querySelector('h1')?.textContent).toBe('Choose a new password')
    expect(submitButton().disabled).toBe(false)
  })
})

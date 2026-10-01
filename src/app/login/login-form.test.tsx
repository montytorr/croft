import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginForm } from './login-form'

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/lib/api/mutate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/mutate')>()),
  mutate: mutateMock,
}))

describe('LoginForm: forgot your password', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const render = async (canReset: boolean) => {
    await act(async () => root.render(<LoginForm canReset={canReset} />))
  }
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const submit = async () => {
    await act(async () => {
      container.querySelector('form')!.requestSubmit()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mutateMock.mockReset().mockResolvedValue({ ok: true, data: { ok: true } })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('offers nothing when this Croft cannot send email', async () => {
    await render(false)
    expect(container.textContent).toContain('Welcome back')
    expect(button('Forgot your password?')).toBeUndefined()
  })

  it('asks for the email, sends it, and confirms without saying whether it exists', async () => {
    await render(true)
    await type(container.querySelector<HTMLInputElement>('input[type="email"]')!, 'cal@x.dev')
    await act(async () => button('Forgot your password?')!.click())

    expect(container.querySelector('h1')?.textContent).toBe('Forgot your password?')
    // The address typed on the sign-in form carries over.
    expect(container.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe('cal@x.dev')
    expect(container.querySelector('input[type="password"]')).toBeNull()

    await submit()
    expect(mutateMock).toHaveBeenCalledWith('/api/auth/forgot', { method: 'POST', body: { email: 'cal@x.dev' } })
    expect(container.querySelector('h1')?.textContent).toBe('Check your email')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('If cal@x.dev belongs to an account')
  })

  it('shows the same confirmation whatever the server answered about the address', async () => {
    mutateMock.mockResolvedValue({ ok: false, error: 'No such user', code: 'not_found' })
    await render(true)
    await act(async () => button('Forgot your password?')!.click())
    await type(container.querySelector<HTMLInputElement>('input[type="email"]')!, 'nobody@x.dev')
    await submit()
    expect(container.querySelector('h1')?.textContent).toBe('Check your email')
    expect(container.textContent).not.toContain('No such user')
  })

  it('surfaces a rate limit, which says nothing about the address', async () => {
    mutateMock.mockResolvedValue({ ok: false, error: 'Too many requests. Retry in 60s.', code: 'rate_limited' })
    await render(true)
    await act(async () => button('Forgot your password?')!.click())
    await type(container.querySelector<HTMLInputElement>('input[type="email"]')!, 'cal@x.dev')
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Too many requests. Retry in 60s.')
    expect(container.querySelector('h1')?.textContent).toBe('Forgot your password?')
  })

  it('says when email went away since the page loaded, rather than claiming it sent', async () => {
    mutateMock.mockResolvedValue({
      ok: false,
      error: 'Email is not set up on this Croft: set RESEND_API_KEY and CROFT_MAIL_FROM',
      code: 'mail_not_configured',
    })
    await render(true)
    await act(async () => button('Forgot your password?')!.click())
    await type(container.querySelector<HTMLInputElement>('input[type="email"]')!, 'cal@x.dev')
    await submit()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Email is not set up')
    expect(container.querySelector('h1')?.textContent).toBe('Forgot your password?')
  })

  it('goes back to sign in', async () => {
    await render(true)
    await act(async () => button('Forgot your password?')!.click())
    await act(async () => button('Back to sign in')!.click())
    expect(container.querySelector('h1')?.textContent).toBe('Welcome back')
  })
})

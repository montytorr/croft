import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminUser } from '@/lib/api/users'
import { UsersManager } from './users-manager'

const { mutateMock, refreshMock } = vi.hoisted(() => ({
  mutateMock: vi.fn(),
  refreshMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }))
vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))

const user = (overrides: Partial<AdminUser>): AdminUser => ({
  id: 'active-user',
  email: 'active@example.test',
  displayName: 'Active User',
  role: 'member',
  active: true,
  deletedAt: null,
  bannedUntil: null,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  keyCount: 1,
  activeKeyCount: 1,
  openTaskCount: 0,
  ...overrides,
})

const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const buttonNamed = (root: HTMLElement, name: string) => {
  const button = [...root.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === name)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return button
}

describe('UsersManager destructive actions', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mutateMock.mockReset().mockResolvedValue({ ok: true, data: {} })
    refreshMock.mockReset()
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: 'key-1',
          agentName: 'clawclaw',
          name: 'Workstation',
          keyPrefix: 'croft_abcd',
          lastUsedAt: null,
          revokedAt: null,
          createdAt: '2026-09-17T00:00:00.000Z',
          revoked: false,
        }],
      }),
    }))
    await act(async () => {
      root.render(<UsersManager users={[
        user({}),
        user({
          id: 'disabled-user',
          email: 'disabled@example.test',
          displayName: 'Disabled User',
          active: false,
          deletedAt: '2026-09-17T01:00:00.000Z',
          keyCount: 0,
          activeKeyCount: 0,
        }),
      ]} currentUserId="active-user" />)
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('keeps Disable, Restore, and Revoke outside edit forms and never PATCHes user edits', async () => {
    const disable = buttonNamed(container, 'Disable user')
    const restore = buttonNamed(container, 'Restore user')

    expect(disable.type).toBe('button')
    expect(restore.type).toBe('button')
    expect(disable.form).toBeNull()
    expect(restore.form).toBeNull()

    await click(buttonNamed(container, 'Manage agent keys'))

    const revoke = buttonNamed(container, 'Revoke')
    expect(revoke.type).toBe('button')
    expect(revoke.form).toBeNull()
    await click(revoke)
    await click(disable)
    await click(restore)

    expect(mutateMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: 'PATCH' }),
    )
  })
})

describe('UsersManager handing over open tasks (CROFT-310)', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const confirmMock = vi.fn(() => true)

  const render = async (users: AdminUser[]) => {
    await act(async () => {
      root.render(<UsersManager users={users} currentUserId="admin" />)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mutateMock.mockReset().mockResolvedValue({ ok: true, data: {} })
    refreshMock.mockReset()
    confirmMock.mockClear()
    vi.stubGlobal('confirm', confirmMock)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const admin = user({ id: 'admin', email: 'admin@example.test', displayName: 'Admin', role: 'admin' })
  const other = user({ id: 'other', email: 'other@example.test', displayName: 'Other' })
  const owner = user({ id: 'owner', email: 'owner@example.test', displayName: 'Owner', openTaskCount: 4 })

  it('shows each user’s open-task count', async () => {
    await render([admin, owner])
    expect(container.textContent).toContain('4 open tasks')
    expect(container.textContent).toContain('0 open tasks')
  })

  it('asks who takes the tasks over, defaulting to the acting admin, and sends reassignTo', async () => {
    await render([admin, other, owner])
    const ownerCard = [...container.querySelectorAll('article')]
      .find((article) => article.querySelector<HTMLInputElement>('input[name="email"]')?.value === 'owner@example.test')
    await click(buttonNamed(ownerCard!, 'Disable user'))

    expect(confirmMock).not.toHaveBeenCalled()
    expect(mutateMock).not.toHaveBeenCalled()
    const panel = container.querySelector('[role="group"]')
    expect(panel?.textContent).toContain('4 open tasks')
    const picker = panel?.querySelector('select')
    expect(picker?.value).toBe('admin')
    expect([...(picker?.options ?? [])].map((option) => option.value)).toEqual(['admin', 'other'])

    for (const button of panel?.querySelectorAll('button') ?? []) {
      expect(button.type).toBe('button')
      expect(button.form).toBeNull()
    }

    await act(async () => {
      picker!.value = 'other'
      picker!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(buttonNamed(container, 'Disable and reassign'))

    expect(mutateMock).toHaveBeenCalledTimes(1)
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/users/owner', {
      method: 'DELETE',
      body: { reassignTo: 'other' },
    })
    expect(refreshMock).toHaveBeenCalled()
    expect(container.querySelector('[role="group"]')).toBeNull()
  })

  it('says when nobody can take the tasks over, and cancels without writing anything', async () => {
    await render([owner])
    await click(buttonNamed(container, 'Disable user'))
    expect(container.textContent).toContain('No other active user can take them over.')
    expect(container.textContent).not.toContain('Disable and reassign')
    await click(buttonNamed(container, 'Cancel'))

    expect(container.querySelector('[role="group"]')).toBeNull()
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('offers to hand on the open tasks of a user disabled before the rule', async () => {
    await render([
      admin,
      user({ ...owner, active: false, deletedAt: '2026-09-17T01:00:00.000Z' }),
    ])
    await click(buttonNamed(container, 'Reassign open tasks'))
    await click(buttonNamed(container, 'Reassign tasks'))

    expect(mutateMock).toHaveBeenCalledWith('/api/v1/users/owner', {
      method: 'DELETE',
      body: { reassignTo: 'admin' },
    })
  })
})

describe('UsersManager password reset and email (v0.5)', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const admin = user({ id: 'admin', email: 'admin@example.test', displayName: 'Admin', role: 'admin' })
  const other = user({ id: 'other', email: 'other@example.test', displayName: 'Other' })

  const render = async (mailReady: boolean, users: AdminUser[] = [admin, other]) => {
    await act(async () => {
      root.render(<UsersManager users={users} currentUserId="admin" mailReady={mailReady} />)
    })
  }

  const cardOf = (email: string) => [...container.querySelectorAll('article')]
    .find((article) => article.querySelector<HTMLInputElement>('input[name="email"]')?.defaultValue === email)!

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mutateMock.mockReset().mockResolvedValue({ ok: true, data: {} })
    refreshMock.mockReset()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('has no way to type someone else’s password', async () => {
    await render(true)
    const card = cardOf('other@example.test')
    expect(card.querySelector('input[type="password"]')).toBeNull()
    expect(card.textContent).not.toContain('Reset password')
  })

  it('emails a reset link and shows only the masked address it went to', async () => {
    mutateMock.mockResolvedValue({ ok: true, data: { sent: true, to: 'o•••@example.test' } })
    await render(true)
    const card = cardOf('other@example.test')
    await click(buttonNamed(card, 'Send a reset link'))

    expect(mutateMock).toHaveBeenCalledTimes(1)
    expect(mutateMock).toHaveBeenCalledWith(`/api/v1/users/${other.id}/password-reset`, { method: 'POST' })
    expect(card.querySelector('[role="status"]')?.textContent).toBe('Sent to o•••@example.test')
  })

  it('disables the button and says why when email is not set up', async () => {
    await render(false)
    const card = cardOf('other@example.test')
    expect(buttonNamed(card, 'Send a reset link').disabled).toBe(true)
    expect(card.textContent).toContain('Email is not set up here, so reset links cannot be sent.')
  })

  it('explains a refusal from the server next to the button', async () => {
    mutateMock.mockResolvedValue({ ok: false, error: 'Service unavailable', code: 'mail_not_configured' })
    await render(true)
    const card = cardOf('other@example.test')
    await click(buttonNamed(card, 'Send a reset link'))
    expect(card.querySelector('[role="alert"]')?.textContent).toContain('Email is not set up here')

    mutateMock.mockResolvedValue({ ok: false, error: 'The email could not be sent.', code: 'mail_send_failed' })
    await click(buttonNamed(card, 'Send a reset link'))
    expect(card.querySelector('[role="alert"]')?.textContent).toBe('The email could not be sent.')
    expect(card.querySelector('[role="status"]')).toBeNull()
  })

  it('shows another user’s email read-only and never sends it', async () => {
    await render(true)
    const card = cardOf('other@example.test')
    const email = card.querySelector<HTMLInputElement>('input[name="email"]')!
    expect(email.readOnly).toBe(true)

    await click(buttonNamed(card, 'Save changes'))
    expect(mutateMock).toHaveBeenCalledTimes(1)
    const [url, init] = mutateMock.mock.calls[0]!
    expect(url).toBe('/api/v1/users/other')
    expect(init.method).toBe('PATCH')
    expect(init.body).not.toHaveProperty('email')
    expect(init.body).toEqual({ displayName: 'Other', role: 'member' })
  })

  it('keeps your own email editable, and sends it only when it changed', async () => {
    await render(true)
    const card = cardOf('admin@example.test')
    const email = card.querySelector<HTMLInputElement>('input[name="email"]')!
    expect(email.readOnly).toBe(false)

    await click(buttonNamed(card, 'Save changes'))
    expect(mutateMock.mock.calls[0]![1].body).not.toHaveProperty('email')

    email.value = 'me@example.test'
    await click(buttonNamed(card, 'Save changes'))
    expect(mutateMock.mock.calls[1]![1].body).toEqual({ email: 'me@example.test', displayName: 'Admin', role: 'admin' })
  })
})

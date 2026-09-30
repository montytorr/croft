import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeKeyDialog } from './change-key-dialog'

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }))
vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))

const project = { id: 'p-hol', key: 'HOL', title: 'Holloway' }
const retired = [
  { key: 'AC', project_id: 'p-hol', current: 'HOL' },
  { key: 'ACC', project_id: 'p-holc', current: 'HOLC' },
]

describe('ChangeKeyDialog', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let onChanged: ReturnType<typeof vi.fn>

  const input = () => document.body.querySelector('input') as HTMLInputElement
  const submit = () =>
    [...document.body.querySelectorAll('button')].find((b) =>
      /^(Change|Changing)/.test(b.textContent?.trim() ?? ''),
    ) as HTMLButtonElement
  const hint = () => document.body.querySelector('#change-key-hint')?.textContent ?? ''

  const type = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mutateMock.mockReset()
    onChanged = vi.fn()
    await act(async () => {
      root.render(
        <ChangeKeyDialog
          project={project}
          liveKeys={['HOL', 'HOLC', 'CROFT']}
          retired={retired}
          onClose={() => {}}
          onChanged={onChanged}
        />,
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('explains that old refs keep resolving and the old key is spent', () => {
    const text = document.body.textContent ?? ''
    expect(text).toContain('Old refs keep working')
    expect(text).toContain('HOL stays reserved for this project')
    expect(text).toContain('No other project can ever take it')
  })

  it('stays disarmed until the key is valid', async () => {
    expect(submit().disabled).toBe(true)
    // One letter is a valid key now (the todos project is `T`); a leading
    // digit still is not.
    await type('9')
    expect(submit().disabled).toBe(true)
    expect(hint()).toBe('One to ten letters or digits, starting with a letter.')
    await type('hwy')
    expect(submit().disabled).toBe(false)
    expect(submit().textContent).toBe('Change to HWY')
  })

  it('refuses another project’s retired key before asking the server', async () => {
    await type('ACC')
    expect(submit().disabled).toBe(true)
    expect(hint()).toContain('ACC used to be HOLC')
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('patches the key by project id and reports the new key', async () => {
    mutateMock.mockResolvedValue({ ok: true, data: { key: 'HWY', former_key: 'HOL' } })
    await type('HWY')
    await act(async () => {
      submit().click()
    })
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/projects/p-hol', {
      method: 'PATCH',
      body: { key: 'HWY' },
    })
    expect(onChanged).toHaveBeenCalledWith('HWY')
  })

  it('shows the server’s refusal in place and stays open', async () => {
    mutateMock.mockResolvedValue({
      ok: false,
      code: 'conflict',
      error: 'OLD is already in use, or was retired by another project.',
    })
    await type('OLD')
    await act(async () => {
      submit().click()
    })
    expect(hint()).toBe('OLD is already in use, or was retired by another project.')
    expect(onChanged).not.toHaveBeenCalled()
  })
})

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeleteSubjectDialog } from './delete-subject-dialog'

describe('the delete subject dialog', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const onCancel = vi.fn()
  const onConfirm = vi.fn()

  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!
  const input = () => document.querySelector<HTMLInputElement>('input')!
  const type = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    onCancel.mockReset()
    onConfirm.mockReset()
    onConfirm.mockResolvedValue(true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () =>
      root.render(
        <DeleteSubjectDialog subjectRef="S-12" subjectTitle="pgvector" todos={3} onCancel={onCancel} onConfirm={onConfirm} />,
      ),
    )
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  it('says what goes and what stays, and focuses Cancel', () => {
    const text = document.querySelector('[role="alertdialog"]')!.textContent
    expect(text).toContain('3 todos')
    expect(text).toContain('Tasks handed off to another tracker stay there.')
    expect(text).toContain('This cannot be undone')
    expect(document.activeElement?.textContent).toBe('Cancel')
  })

  it('keeps the destructive button disabled until the ref is typed', async () => {
    expect(button('Delete subject').disabled).toBe(true)
    await type('S-1')
    expect(button('Delete subject').disabled).toBe(true)
    await type('S-12')
    expect(button('Delete subject').disabled).toBe(false)
  })

  it('confirms only once the ref matches', async () => {
    await type('nope')
    await act(async () => button('Delete subject').click())
    expect(onConfirm).not.toHaveBeenCalled()

    await type('S-12')
    await act(async () => button('Delete subject').click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancels on Escape', async () => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onCancel).toHaveBeenCalled()
  })
})

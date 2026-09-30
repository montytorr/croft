import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './markdown-editor'

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }))
vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))

describe('MarkdownEditor', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement
  const textarea = () => container.querySelector('textarea')
  const rich = () => container.querySelector('.tiptap')

  const render = async (initial: string) => {
    await act(async () => {
      root.render(<MarkdownEditor taskId="t-1" initial={initial} />)
    })
  }

  const click = async (label: string) => {
    await act(async () => {
      button(label).click()
    })
  }

  const type = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea(), value)
      textarea()?.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mutateMock.mockReset()
    mutateMock.mockResolvedValue({ ok: true, data: {} })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('edits a body with raw HTML as markdown, never through the rich editor', async () => {
    const body = 'Steps:\n\n<details><summary>Log</summary>\n\nboom\n\n</details>'
    await render(body)
    await click('Edit')

    expect(rich()).toBeNull()
    expect(textarea()?.value).toBe(body)
    expect(container.textContent).toContain('Editing as markdown.')
    expect(container.textContent).toMatch(/raw HTML/)

    await type(`${body}\n\nAnd one more line.`)
    await click('Save')

    expect(mutateMock).toHaveBeenCalledWith('/api/v1/tasks/t-1', {
      method: 'PATCH',
      body: { description: `${body}\n\nAnd one more line.` },
    })
  })

  it('does not write a markdown body back when nothing changed', async () => {
    await render('Before <span>x</span> after.')
    await click('Edit')
    await click('Save')

    expect(mutateMock).not.toHaveBeenCalled()
    expect(textarea()).toBeNull()
  })

  it('opens a body with a table in the rich editor, and leaves it alone on an unedited save', async () => {
    await render('| a | b |\n| :--- | ---: |\n| `x \\| y` | **2** |')
    await click('Edit')

    expect(textarea()).toBeNull()
    expect(rich()?.querySelector('table')).not.toBeNull()
    expect(container.textContent).not.toContain('Editing as markdown.')

    await click('Save')
    expect(mutateMock).not.toHaveBeenCalled()
  })
})

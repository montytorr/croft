import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WriteUp } from './writeup'

const { mutateMock, refresh, uploadMock } = vi.hoisted(() => ({ mutateMock: vi.fn(), refresh: vi.fn(), uploadMock: vi.fn() }))
vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/lib/editor/upload', async (original) => ({ ...await original<typeof import('@/lib/editor/upload')>(), uploadSubjectFile: uploadMock }))

describe('subject write-up', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  const source = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Write-up Markdown"]')!
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!
  const render = async (body: string) => { await act(async () => root.render(<WriteUp subjectRef="S-12" title="An experiment" body={body} />)) }
  const click = async (label: string) => { await act(async () => button(label).click()) }
  const type = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(source(), text)
      source().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mutateMock.mockReset().mockResolvedValue({ ok: true, data: {} })
    uploadMock.mockReset()
    refresh.mockReset()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('edits ordinary Markdown as source and renders only the preview', async () => {
    const body = '## The question\n\n**Bold** and `code`.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'
    await render(body)
    await click('Edit write-up')
    expect(source().value).toBe(body)
    expect(document.querySelector('[contenteditable]')).toBeNull()
    const preview = document.querySelector('section[aria-label="Preview"]')!
    expect(preview.querySelector('h2')?.textContent).toBe('The question')
    expect(preview.querySelector('strong')?.textContent).toBe('Bold')
    expect(preview.querySelector('table')).not.toBeNull()
    await type('## A different question\n\nNew **evidence**.')
    expect(preview.querySelector('h2')?.textContent).toBe('A different question')
    expect(preview.querySelector('strong')?.textContent).toBe('evidence')
  })

  it('saves the exact source, including HTML, escaped pipes and whitespace', async () => {
    await render('## First question')
    await click('Edit write-up')
    const draft = '\n## Notes\n\n<details><summary>Evidence</summary>\n\n| a | b |\n| --- | --- |\n| `x \\| y` | 2 |\n\n</details>\n\n```txt\n  literal spacing\n```\n'
    await type(draft)
    await click('Save write-up')
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/subjects/S-12', { method: 'PATCH', body: { body: draft } })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('does not write an unchanged body back', async () => {
    await render('## Notes\n\nOriginal formatting.\n')
    await click('Edit write-up')
    await click('Save write-up')
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('keeps a failed save editable for retry', async () => {
    await render('## Original')
    await click('Edit write-up')
    await type('## Unsaved draft')
    mutateMock.mockResolvedValueOnce({ ok: false, error: 'Connection lost' })
    await click('Save write-up')
    expect(source().value).toBe('## Unsaved draft')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Nothing was saved')
    expect(source().disabled).toBe(false)
    await click('Save write-up')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('preserves typing when another writer refreshes the body', async () => {
    await render('## Original')
    await click('Edit write-up')
    await type('## My draft')
    await render('## Another writer')
    expect(source().value).toBe('## My draft')
    await click('Save write-up')
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/subjects/S-12', { method: 'PATCH', body: { body: '## My draft' } })
  })

  it('waits for pasted images before saving their stable Markdown URLs', async () => {
    let finish!: (result: unknown) => void
    uploadMock.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await render('## Notes')
    await click('Edit write-up')
    source().setSelectionRange(source().value.length, source().value.length)
    await act(async () => {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { files: [new File(['image'], 'proof.png', { type: 'image/png' })] } })
      source().dispatchEvent(event)
    })
    expect(button('Save write-up').disabled).toBe(true)
    expect(source().value).toContain('Uploading proof.png')
    await act(async () => finish({ ok: true, data: { filename: 'proof.png', content_url: '/api/v1/attachments/proof/content' } }))
    expect(button('Save write-up').disabled).toBe(false)
    await click('Save write-up')
    expect(mutateMock.mock.calls[0]?.[1].body.body).toBe('## Notes\n\n![proof.png](/api/v1/attachments/proof/content)')
  })
})

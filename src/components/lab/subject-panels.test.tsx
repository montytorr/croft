import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@/lib/lab/types'
import { FilesPanel } from './files-panel'
import { TodosPanel } from './todos-panel'
import type { PageTodo } from './todo-lanes'

const { mutateMock, refresh } = vi.hoisted(() => ({ mutateMock: vi.fn(), refresh: vi.fn() }))
vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

const file = (over: Partial<Attachment>): Attachment => ({
  id: 'f1',
  filename: 'proto.html',
  mime_type: 'text/html',
  size_bytes: 2048,
  preview_url: '/api/files?sig=preview',
  download_url: '/api/files?sig=download',
  content_url: '/api/v1/attachments/f1/content',
  kind: 'html',
  uploaded_by: 'cal',
  created_at: '2026-09-30T10:00:00Z',
  ...over,
})

const todo = (over: Partial<PageTodo>): PageTodo => ({
  id: 't1',
  ref: 'T-1',
  number: 1,
  title: 'Try it',
  status: 'todo',
  claimed_by: null,
  handoff: null,
  updated_at: '2026-09-30T10:00:00Z',
  ...over,
})

describe('subject panels', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const render = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(node)
    })
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mutateMock.mockReset()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  it('previews HTML only in a fully sandboxed frame', async () => {
    await render(<FilesPanel subjectRef="S-1" files={[file({})]} />)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Open proto.html"]')?.click()
    })
    const frame = document.querySelector('iframe')
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute('sandbox')).toBe('')
    expect(frame?.getAttribute('src')).toBe('/api/v1/attachments/f1/content')
  })

  it('shows an image by its stable URL, never the signed one', async () => {
    await render(<FilesPanel subjectRef="S-1" files={[file({ id: 'i1', filename: 'a.png', mime_type: 'image/png', kind: 'image', content_url: '/c/i1' })]} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/c/i1')
  })

  it('offers no status control on a pushed todo and shows its hand-off', async () => {
    await render(
      <TodosPanel
        subjectRef="S-1"
        todos={[todo({}), todo({ id: 't2', ref: 'T-2', number: 2, handoff: { tracker: 'acme', ref: 'ACME-9', url: null, status: 'doing', synced_at: null } })]}
      />,
    )
    expect(container.querySelector('select[aria-label="Status of T-1"]')).not.toBeNull()
    expect(container.querySelector('select[aria-label="Status of T-2"]')).toBeNull()
    expect(container.textContent).toContain('ACME-9')
    expect(container.textContent).toContain('doing')
    expect(container.querySelector('a[href^="https://"]')).toBeNull()
  })

  it('links the badge to the hand-off URL and takes a hand-off back after confirming', async () => {
    mutateMock.mockResolvedValue({ ok: true, data: {} })
    const handoff = { tracker: 'acme', ref: 'ACME-9', url: 'https://acme.test/9', status: 'doing', synced_at: null }
    await render(<TodosPanel subjectRef="S-1" todos={[todo({ handoff })]} />)
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://acme.test/9"]')!
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noopener')
    expect(link.title).toBe('Handed off to acme: its status moves there')
    expect(container.textContent).not.toMatch(/cairn/i)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Take T-1 back from acme"]')?.click()
    })
    expect(mutateMock).not.toHaveBeenCalled()
    await act(async () => {
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'))
        .find((b) => b.textContent === 'Take back')
        ?.click()
    })
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/tasks/T-1/handoff', { method: 'DELETE' })
    expect(container.querySelector('a[href="https://acme.test/9"]')).toBeNull()
  })

  it('asks for a resolution before closing a todo, and patches an ordinary move at once', async () => {
    mutateMock.mockResolvedValue({ ok: true, data: {} })
    await render(<TodosPanel subjectRef="S-1" todos={[todo({})]} />)
    const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="Status of T-1"]')!

    await act(async () => {
      select().value = 'doing'
      select().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/tasks/T-1', { method: 'PATCH', body: { status: 'doing' } })

    mutateMock.mockClear()
    await act(async () => {
      select().value = 'done'
      select().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(mutateMock).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Record what was actually done')
  })
})

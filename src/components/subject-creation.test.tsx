import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PeopleProvider } from '@/components/people-context'
import { SubjectCreationProvider, useCreateSubject } from './subject-creation'

const { mutateMock, push } = vi.hoisted(() => ({ mutateMock: vi.fn(), push: vi.fn() }))
vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push }),
  usePathname: () => '/',
}))

const CAL = { id: 'u-cal', email: 'cal@x.dev', name: 'Cal', active: true }
const MAEL = { id: 'u-mael', email: 'mael@x.dev', name: 'Mael', active: true }

const Opener = () => {
  const { open } = useCreateSubject()
  return (
    <button type="button" onClick={open}>
      open
    </button>
  )
}

describe('the new-subject dialog', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mutateMock.mockReset()
    mutateMock.mockResolvedValue({ ok: true, data: { number: 12 } })
    push.mockReset()
    await act(async () => {
      root.render(
        <PeopleProvider people={[CAL, MAEL]} currentUserId={CAL.id}>
          <SubjectCreationProvider stages={[]} tags={[]} projects={[]}>
            <Opener />
          </SubjectCreationProvider>
        </PeopleProvider>,
      )
    })
    await act(async () => container.querySelector('button')!.click())
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  const type = async (text: string) => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const choose = async (label: string, value: string) => {
    const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
    await act(async () => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const submit = async () => {
    const create = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Create subject')!
    await act(async () => create.click())
  }

  it('files a subject in the lab unless told otherwise, and sends no visibility for it', async () => {
    await type('pgvector')
    await submit()
    const body = mutateMock.mock.calls[0]![1].body
    expect(body).not.toHaveProperty('visibility')
    expect(body).not.toHaveProperty('members')
  })

  it('shares with the people picked when Members is chosen', async () => {
    await type('pgvector')
    await choose('Who can see it', 'members')
    const mael = document.querySelector<HTMLButtonElement>('[aria-label="Members"] button')!
    expect(mael.textContent).toContain('Mael')
    await act(async () => mael.click())
    await submit()
    expect(mutateMock.mock.calls[0]![1].body).toMatchObject({ visibility: 'members', members: [MAEL.id] })
    expect(push).toHaveBeenCalledWith('/subjects/12')
  })

  it('files a private or members subject as its owner: the owner is you, whoever was picked before', async () => {
    await type('pgvector')
    await choose('Owner', MAEL.id)
    await choose('Who can see it', 'private')
    expect(document.querySelector('select[aria-label="Owner"]')).toBeNull()
    await submit()
    expect(mutateMock.mock.calls[0]![1].body).toMatchObject({ visibility: 'private', owner: 'me' })
    expect(mutateMock.mock.calls[0]![1].body).not.toHaveProperty('members')
  })
})

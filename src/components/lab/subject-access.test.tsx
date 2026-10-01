import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PeopleProvider } from '@/components/people-context'
import type { Subject, SubjectNote } from '@/lib/lab/types'
import { LogPanel } from './log-panel'
import { SubjectAccess, canManageAccess } from './subject-access'
import { LockMark, VisibilityBadge } from './visibility'

const { mutateMock, refresh } = vi.hoisted(() => ({ mutateMock: vi.fn(), refresh: vi.fn() }))
vi.mock('@/lib/api/mutate', () => ({ mutate: mutateMock }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

const CAL = { id: 'u-cal', email: 'cal@x.dev', name: 'Cal', active: true }
const MAEL = { id: 'u-mael', email: 'mael@x.dev', name: 'Mael', active: true }
const SAM = { id: 'u-sam', email: 'sam@x.dev', name: 'Sam', active: true }

const subject = (over: Partial<Subject> = {}): Subject => ({
  id: 's1',
  ref: 'S-12',
  number: 12,
  title: 'pgvector for recall',
  stage: { id: 'st', name: 'exploring', color: '', category: 'active', position: 1 },
  tags: [],
  project: null,
  owner: { id: CAL.id, name: CAL.name },
  conclusion: null,
  todos: { open: 0, done: 0 },
  position: 0,
  actor_id: 'cal',
  created_at: '2026-09-30T10:00:00Z',
  updated_at: '2026-09-30T10:00:00Z',
  archived_at: null,
  visibility: 'private',
  members: [],
  body: null,
  concluded_at: null,
  ...over,
})

describe('who can see a subject', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const render = async (node: React.ReactNode, currentUserId = CAL.id, people = [CAL, MAEL, SAM]) => {
    await act(async () => {
      root.render(
        <PeopleProvider people={people} currentUserId={currentUserId}>
          {node}
        </PeopleProvider>,
      )
    })
  }
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mutateMock.mockReset()
    mutateMock.mockResolvedValue({ ok: true, data: {} })
    refresh.mockReset()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  const visibilitySwitch = () => container.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Visibility"]')
  const radios = () => [...(visibilitySwitch()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])]

  it('gives the owner a visible Private | Members switch, never the lab', async () => {
    await render(<SubjectAccess subject={subject()} isAdmin={false} />)
    // A real control, not a transparent select laid over the label.
    expect(container.querySelector('select')).toBeNull()
    expect(radios().map((r) => r.textContent)).toEqual(['Private', 'Members'])
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    // One tab stop: the chosen option.
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1])

    await act(async () => radios()[1]!.click())
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/subjects/S-12', { method: 'PATCH', body: { visibility: 'members' } })
  })

  it('does not write when the owner picks the audience it already has', async () => {
    await render(<SubjectAccess subject={subject({ visibility: 'members' })} isAdmin={false} />)
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true'])
    await act(async () => radios()[1]!.click())
    expect(mutateMock).not.toHaveBeenCalled()
  })

  it('moves and chooses with the arrow keys', async () => {
    await render(<SubjectAccess subject={subject()} isAdmin={false} />)
    await act(async () => {
      radios()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/subjects/S-12', { method: 'PATCH', body: { visibility: 'members' } })
    expect(document.activeElement?.textContent).toBe('Members')
  })

  it('publishes only after a confirmation that says it cannot be undone', async () => {
    await render(<SubjectAccess subject={subject()} isAdmin={false} />)
    await act(async () => button('Publish to the lab')!.click())
    expect(mutateMock).not.toHaveBeenCalled()

    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('This cannot be undone')
    // The safe choice has focus.
    expect(document.activeElement?.textContent).toBe('Cancel')

    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Publish to the lab')!
    await act(async () => confirm.click())
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/subjects/S-12/publish', { method: 'POST' })
    expect(refresh).toHaveBeenCalled()
  })

  it('adds and removes members by id, and never offers the owner', async () => {
    await render(<SubjectAccess subject={subject({ visibility: 'members', members: [{ id: MAEL.id, name: MAEL.name }] })} isAdmin={false} />)
    await act(async () => button('Add people')!.click())
    const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
    // The last child is the name; the avatar's initials come before it.
    expect(rows.map((b) => b.lastElementChild?.textContent)).toEqual(['Mael', 'Sam'])

    const sam = rows.find((b) => b.lastElementChild?.textContent === 'Sam')!
    await act(async () => sam.click())
    expect(mutateMock).toHaveBeenCalledWith('/api/v1/subjects/S-12/members', { method: 'POST', body: { user: SAM.id } })

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove Mael"]')!.click())
    expect(mutateMock).toHaveBeenCalledWith(`/api/v1/subjects/S-12/members/${MAEL.id}`, { method: 'DELETE' })
  })

  it('shows a member who is not the owner the audience without any control over it', async () => {
    await render(
      <SubjectAccess subject={subject({ visibility: 'members', members: [{ id: MAEL.id, name: MAEL.name }] })} isAdmin={false} />,
      MAEL.id,
    )
    expect(container.textContent).toContain('Mael (you)')
    expect(visibilitySwitch()).toBeNull()
    expect(container.textContent).toContain('Members')
    expect(container.querySelector('button[aria-label^="Remove"]')).toBeNull()
    expect(button('Add people')).toBeUndefined()
    expect(button('Publish to the lab')).toBeUndefined()
  })

  it('offers nothing to change on a subject already in the lab', async () => {
    await render(<SubjectAccess subject={subject({ visibility: 'lab' })} isAdmin />)
    expect(container.textContent).toContain('Lab')
    expect(container.querySelector('select')).toBeNull()
    expect(visibilitySwitch()).toBeNull()
    expect(button('Publish to the lab')).toBeUndefined()
  })

  it('lets the owner, and only the owner, manage the audience — no administrator stand-in', () => {
    expect(canManageAccess({ id: CAL.id, name: 'Cal' }, { currentUserId: CAL.id })).toBe(true)
    expect(canManageAccess({ id: CAL.id, name: 'Cal' }, { currentUserId: MAEL.id })).toBe(false)
    // An owner who is gone, or none at all: nobody, administrators included.
    expect(canManageAccess({ id: 'u-gone', name: 'Gone' }, { currentUserId: MAEL.id })).toBe(false)
    expect(canManageAccess(null, { currentUserId: MAEL.id })).toBe(false)
  })

  it('gives an administrator no controls on a members subject whose owner is gone', async () => {
    await render(
      <SubjectAccess
        subject={subject({ visibility: 'members', owner: { id: 'u-gone', name: 'Gone' }, members: [{ id: MAEL.id, name: MAEL.name }] })}
        isAdmin
      />,
      MAEL.id,
      [CAL, MAEL, SAM],
    )
    expect(container.textContent).toContain('Mael (you)')
    expect(visibilitySwitch()).toBeNull()
    expect(container.querySelector('button[aria-label^="Remove"]')).toBeNull()
    expect(button('Add people')).toBeUndefined()
    expect(button('Publish to the lab')).toBeUndefined()
  })

  it('gives an administrator no controls on a subject with no owner', async () => {
    await render(<SubjectAccess subject={subject({ owner: null })} isAdmin />, MAEL.id)
    expect(visibilitySwitch()).toBeNull()
    expect(button('Publish to the lab')).toBeUndefined()
  })

  it('marks a card only when the subject is not in the lab, and names the audience in the header', async () => {
    await render(
      <>
        <span data-case="lab"><LockMark visibility="lab" /></span>
        <span data-case="private"><LockMark visibility="private" /></span>
        <span data-case="badge"><VisibilityBadge visibility="members" members={3} /></span>
      </>,
    )
    expect(container.querySelector('[data-case="lab"]')!.innerHTML).toBe('')
    expect(container.querySelector('[data-case="private"] [title]')!.getAttribute('title')).toBe('Private: only its owner sees it')
    expect(container.querySelector('[data-case="badge"]')!.textContent).toBe('Members · 3')
  })

  it('logs a visibility change like a stage move: set plain, and not a kind anyone can write', async () => {
    const note = (over: Partial<SubjectNote>): SubjectNote => ({
      id: 'n1',
      kind: 'visibility',
      note: 'published to the lab',
      actor_type: 'human',
      actor_id: 'Cal',
      created_at: '2026-09-30T10:00:00Z',
      ...over,
    })
    await render(<LogPanel subjectRef="S-12" notes={[note({}), note({ id: 'n2', note: 'shared with **Mael**' })]} />)
    const kinds = [...container.querySelectorAll('[role="radio"]')].map((r) => r.textContent)
    expect(kinds).not.toContain('visibility')
    expect(kinds).not.toContain('stage')
    // Plain text, never markdown: a name is not formatting.
    expect(container.textContent).toContain('shared with **Mael**')
  })
})

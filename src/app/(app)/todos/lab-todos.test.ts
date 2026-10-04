import { describe, expect, it } from 'vitest'
import type { LabTodo } from '@/lib/lab/types'
import {
  groupTodos,
  matchesTodosView,
  openCountsByProject,
  parseTodosView,
  serializeTodosView,
  subjectsOf,
  todosHref,
  DEFAULT_TODOS_VIEW,
} from './lab-todos'

const croft = { name: 'Croft', color: '#5a6f8c' }
const trig = { name: 'Trig', color: '#8a4f1c' }

let n = 0
const todo = (over: Partial<LabTodo> = {}): LabTodo => {
  n += 1
  return {
    id: `t${n}`,
    ref: `T-${n}`,
    number: n,
    title: `todo ${n}`,
    status: 'todo',
    claimed_by: null,
    handoff: null,
    cairn_ref: null,
    cairn_status: null,
    updated_at: `2026-09-${String(10 + n).padStart(2, '0')}T10:00:00Z`,
    priority: 'medium',
    assignee: null,
    subject: null,
    ...over,
  }
}
const subject = (number: number, project: { name: string; color: string } | null = null) => ({
  ref: `S-${number}`,
  number,
  title: `subject ${number}`,
  project,
})

describe('the /todos view in the URL', () => {
  it('reads what it knows and defaults the rest', () => {
    expect(parseTodosView('')).toEqual(DEFAULT_TODOS_VIEW)
    expect(parseTodosView('project=Croft&subject=S-3&group=subject&closed=1')).toEqual({
      project: 'Croft',
      subject: 'S-3',
      group: 'subject',
      closed: true,
    })
    expect(parseTodosView('group=bogus').group).toBe('status')
    // A hand-typed ref reads as the picker's own spelling.
    expect(parseTodosView('subject=s-7').subject).toBe('S-7')
    expect(parseTodosView('subject=7').subject).toBe('S-7')
    expect(parseTodosView('subject=none').subject).toBe('none')
  })

  it('round-trips, leaving defaults out so a plain link stays plain', () => {
    expect(serializeTodosView(DEFAULT_TODOS_VIEW)).toBe('')
    expect(todosHref(DEFAULT_TODOS_VIEW)).toBe('/todos')
    const view = { project: 'Trig Point', subject: 'S-4', group: 'none' as const, closed: true }
    expect(parseTodosView(serializeTodosView(view))).toEqual(view)
  })
})

describe('filtering todos', () => {
  const a = todo({ subject: subject(1, croft) })
  const b = todo({ subject: subject(2, trig), status: 'done' })
  const c = todo({ subject: subject(3) })
  const d = todo()

  const visible = (view: Partial<typeof DEFAULT_TODOS_VIEW>) =>
    [a, b, c, d].filter((t) => matchesTodosView(t, { ...DEFAULT_TODOS_VIEW, ...view })).map((t) => t.id)

  it('hides closed todos unless asked', () => {
    expect(visible({})).toEqual([a.id, c.id, d.id])
    expect(visible({ closed: true })).toEqual([a.id, b.id, c.id, d.id])
  })

  it('filters by lab project name in any case, or none', () => {
    expect(visible({ project: 'croft' })).toEqual([a.id])
    expect(visible({ project: 'Trig', closed: true })).toEqual([b.id])
    expect(visible({ project: 'none' })).toEqual([c.id, d.id])
    expect(visible({ project: 'nope' })).toEqual([])
  })

  it('filters by subject ref, or none', () => {
    expect(visible({ subject: 'S-3' })).toEqual([c.id])
    expect(visible({ subject: 's-1' })).toEqual([a.id])
    expect(visible({ subject: 'none' })).toEqual([d.id])
    expect(visible({ subject: 'garbage' })).toEqual([])
  })
})

describe('grouping todos', () => {
  it('by status, moving work first and finished work last', () => {
    const list = [todo({ status: 'done' }), todo({ status: 'backlog' }), todo({ status: 'doing' }), todo({ status: 'in-review' })]
    expect(groupTodos(list, 'status').map((g) => g.key)).toEqual(['doing', 'in-review', 'backlog', 'done'])
  })

  it('by subject: projects by name, newest subject first, no project then no subject last', () => {
    const list = [
      todo(),
      todo({ subject: subject(5) }),
      todo({ subject: subject(2, trig) }),
      todo({ subject: subject(1, croft) }),
      todo({ subject: subject(9, croft) }),
      todo({ subject: subject(9, croft), status: 'doing' }),
    ]
    const groups = groupTodos(list, 'subject')
    expect(groups.map((g) => g.key)).toEqual(['S-9', 'S-1', 'S-2', 'S-5', 'none'])
    // Within a subject, what is moving comes first.
    expect(groups[0]!.todos.map((t) => t.status)).toEqual(['doing', 'todo'])
  })

  it('into one group, or none at all when there is nothing', () => {
    expect(groupTodos([todo(), todo()], 'none')).toHaveLength(1)
    expect(groupTodos([], 'none')).toEqual([])
    expect(groupTodos([], 'subject')).toEqual([])
  })
})

describe('the pickers', () => {
  it('offers each subject once, in the grouping order', () => {
    const s = subject(4, croft)
    expect(subjectsOf([todo({ subject: s }), todo({ subject: s }), todo({ subject: subject(1) }), todo()]).map((x) => x.ref)).toEqual([
      'S-4',
      'S-1',
    ])
  })

  it('counts open todos per project', () => {
    const counts = openCountsByProject([
      todo({ subject: subject(1, croft) }),
      todo({ subject: subject(1, croft), status: 'done' }),
      todo({ subject: subject(2) }),
      todo(),
    ])
    expect(counts.get('croft')).toBe(1)
    expect(counts.get('none')).toBe(2)
  })
})

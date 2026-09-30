import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MemoryUse } from '@/lib/api/vitals'

/**
 * The memory panel is the only place a human sees whether agents recall what
 * Croft holds. Migration 053 started recording the half of that question that
 * matters most — facts fetched by NAME rather than searched for, and the names
 * that matched nothing — and for a while the page displayed none of it.
 *
 * So this renders the real page against a stubbed aggregate and asserts on the
 * markup, which is the only place the decision is observable. The panel is
 * inline in the page, so there is no smaller unit to reach for.
 */
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/data', () => ({
  currentUser: async () => ({ id: 'user-1', email: 'cal@dispofi.fr', role: 'admin' }),
}))

const vitals = {
  windowHours: 24,
  sessions: { recent: 3, recentWithFiles: 2, recentSummarised: 2, baseline: 4, baselineWithFiles: 3 },
  tasks: { opened: 4, closed: 8, stalled: 1, held: 2, closedWithoutTrace: 0 },
  autoReleased: 0,
  knowledgeWritten: 2,
  agents: [],
}

const work = {
  windowHours: 24,
  openTotal: 3,
  stalledTotal: 1,
  projects: [],
  holding: [],
  dropped: [],
  rework: { reopened: 0, resolutionsRevised: 0, duplicatesFiled: 0 },
}

const baseMemory: MemoryUse = {
  windowHours: 24,
  searches: 12,
  widened: 3,
  zeroResults: 2,
  byAgent: [],
  tasksFiled: 5,
  tasksFiledWithoutChecking: 4,
  recentMisses: ['postgres generated columns'],
}

const memoryUse = vi.fn<() => MemoryUse>(() => baseMemory)

vi.mock('@/lib/api/vitals', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api/vitals')>()
  return {
    ...actual,
    readVitalsFor: async () => vitals,
    readWorkShapeFor: async () => work,
    readMemoryUseFor: async () => memoryUse(),
  }
})

const render = async (memory: MemoryUse) => {
  memoryUse.mockReturnValue(memory)
  const { default: VitalsPage } = await import('./page')
  const element = await VitalsPage({ searchParams: Promise.resolve({}) })
  return renderToStaticMarkup(element)
}

describe('the vitals memory panel shows facts looked up by name', () => {
  it('counts the direct reads and the share that named nothing we hold', async () => {
    const html = await render({
      ...baseMemory,
      directReads: 8,
      directReadMisses: 2,
      recentSlugMisses: [],
    })
    expect(html).toContain('looked up by name')
    expect(html).toContain('naming a fact we do not hold')
    expect(html).toContain('25%')
  })

  it('names each slug that was asked for and does not exist', async () => {
    const html = await render({
      ...baseMemory,
      directReads: 4,
      directReadMisses: 2,
      recentSlugMisses: ['zzz-this-slug-does-not-exist', 'clawdius-sever'],
    })
    expect(html).toContain('Looked up by name, no such entry')
    expect(html).toContain('zzz-this-slug-does-not-exist')
    expect(html).toContain('clawdius-sever')
    // Kept apart from a search that found nothing: a slug miss is a name
    // somebody believed in, not a phrasing the index could not match.
    expect(html).toContain('Asked for and not held')
    expect(html).toContain('postgres generated columns')
  })

  it('adds nothing to the panel when nobody looked anything up', async () => {
    const html = await render({
      ...baseMemory,
      directReads: 0,
      directReadMisses: 0,
      recentSlugMisses: [],
    })
    expect(html).toContain('Is the memory being read')
    expect(html).not.toContain('looked up by name')
  })

  it('shows no zero for a server too old to have counted', async () => {
    // Migration 052 sends none of the three keys. A row reading 0 there is a
    // wrong answer standing in for a missing one.
    const html = await render(baseMemory)
    expect(html).toContain('Is the memory being read')
    expect(html).not.toContain('looked up by name')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('undefined')
  })
})

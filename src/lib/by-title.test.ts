import { describe, expect, it } from 'vitest'
import { byTitle } from './utils'

/**
 * Alphabetical the way a person reads it, not the way this collation sorts.
 *
 * Ordering in SQL looked right until the list was read: Postgres sorted
 * case-sensitively, so every lowercase title — `invoice-api`, `n8n` — sat below
 * every capitalised one, and `SL Gateway` came before `Sales Portal` because
 * `L` precedes `a` in ASCII.
 */
const sorted = (titles: string[]) =>
  titles.map((title) => ({ title })).sort(byTitle).map((p) => p.title)

describe('project ordering', () => {
  it('ignores case, which is the whole bug', () => {
    expect(sorted(['n8n', 'Croft', 'invoice-api', 'Acme Portal'])).toEqual([
      'Acme Portal',
      'Croft',
      'invoice-api',
      'n8n',
    ])
  })

  it('puts Sales Portal before SL Gateway, as a reader would', () => {
    expect(sorted(['SL Gateway', 'Sales Portal'])).toEqual(['Sales Portal', 'SL Gateway'])
  })

  it('orders embedded numbers by value', () => {
    expect(sorted(['Phase 10', 'Phase 2'])).toEqual(['Phase 2', 'Phase 10'])
  })

  it('falls back to the key when a project has no title', () => {
    const rows = [{ key: 'ZZ' }, { key: 'AA' }].sort(byTitle)
    expect(rows.map((r) => r.key)).toEqual(['AA', 'ZZ'])
  })
})

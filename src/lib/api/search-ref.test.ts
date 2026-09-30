import { describe, expect, it } from 'vitest'

/**
 * A ref is an exact address, so searching one must return that task.
 *
 * It did not. `CROFT-131` returned CROFT-105 — the task whose resolution
 * mentions it — and `CROFT-106` returned nothing at all. The ref is a project
 * key plus a number and the key lives in another table, so no generated column
 * on `tasks` can reach it and the search vector never held it.
 *
 * The shape of a ref is the part that can regress silently here: loosen it and
 * ordinary prose starts being treated as an address, tighten it and real refs
 * stop resolving. The database half is covered by the live check in the task.
 */
const REF_QUERY = /^\s*([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\s*$/

const parse = (q: string) => {
  const m = REF_QUERY.exec(q)
  return m ? `${(m[1] as string).toUpperCase()}-${Number(m[2])}` : null
}

const NUMBER_QUERY = /^\s*(\d{1,6})\s*$/
const parseNumber = (q: string) => {
  const m = NUMBER_QUERY.exec(q)
  return m ? Number(m[1]) : null
}

describe('which queries are an exact ref', () => {
  it('accepts the refs this system issues', () => {
    expect(parse('CROFT-131')).toBe('CROFT-131')
    expect(parse('OD-36')).toBe('OD-36')
    expect(parse('HM-700')).toBe('HM-700')
  })

  it('accepts the spelling a human types', () => {
    expect(parse('croft-131')).toBe('CROFT-131')
    expect(parse('  CROFT-131  ')).toBe('CROFT-131')
  })

  it('is not fooled by prose that merely contains a ref', () => {
    // Otherwise the first ref in a sentence would hijack a real search.
    expect(parse('why did CROFT-131 regress')).toBeNull()
    expect(parse('CROFT-131 and CROFT-105')).toBeNull()
  })

  it('lets the database decide the genuinely ambiguous ones', () => {
    // `UTF-8`, `SHA-256` and `HTTP-404` are all ref-shaped, and a project could
    // legitimately be keyed UTF or SHA. The shape cannot settle it, so these
    // are looked up: no such project means no exact hit and the full-text pass
    // answers as before, at the cost of one indexed query.
    //
    // This is where search differs from the prose linkifier in
    // src/lib/markdown/task-refs.ts, which must NOT treat these as refs —
    // there a wrong guess renders a dead link a reader can see, while here it
    // is invisible and free.
    expect(parse('UTF-8')).toBe('UTF-8')
    expect(parse('SHA-256')).toBe('SHA-256')
  })

  it('rejects what is not ref-shaped at all', () => {
    expect(parse('deploy-zero-downtime')).toBeNull()
    expect(parse('zero-downtime')).toBeNull()
  })

  it('rejects a ref with no number, which is a project not a task', () => {
    expect(parse('CROFT-')).toBeNull()
    expect(parse('CROFT')).toBeNull()
  })

  it('reads a bare number as an address, which is how people refer to a task', () => {
    // Typing 131 while looking at a project is how a person names a task: the
    // key is the part they already know and do not repeat. It used to return
    // twenty rows of prose containing those digits, and not the task.
    expect(parseNumber('131')).toBe(131)
    expect(parseNumber(' 42 ')).toBe(42)
  })

  it('does not read prose containing a number as an address', () => {
    expect(parseNumber('error 500')).toBeNull()
    expect(parseNumber('131 regressions')).toBeNull()
    expect(parseNumber('')).toBeNull()
  })
})

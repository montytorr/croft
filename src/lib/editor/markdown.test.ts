/**
 * Resolution of the Tiptap <-> markdown fidelity spike.
 *
 * The question was whether markdown can stay the source of truth while humans
 * edit through a WYSIWYG editor. These tests are the evidence, and they encode
 * what survives and what does not, so a regression is visible.
 */
import { describe, expect, it, vi } from 'vitest'
import { richEditLoss, roundTrip } from './markdown'

/** Stable means a second trip changes nothing — that is what makes editing safe. */
const expectIdempotent = (input: string) => {
  const once = roundTrip(input)
  const twice = roundTrip(once)
  expect(twice).toBe(once)
  return once
}

describe('survives the round trip', () => {
  const cases: [string, string][] = [
    ['headings', '# One\n\n## Two\n\n### Three'],
    ['emphasis', 'Some *italic*, **bold**, and `inline code`.'],
    ['bullet list', '- one\n- two\n- three'],
    ['ordered list', '1. one\n2. two\n3. three'],
    ['nested list', '- one\n    - nested\n    - also nested\n- two'],
    ['task list', '- [ ] undone\n- [x] done'],
    ['fenced code with language', '```sql\nselect 1;\n```'],
    ['blockquote', '> quoted text'],
    ['link', 'See [the docs](https://example.com).'],
    ['image', '![alt](https://example.com/a.png)'],
    ['horizontal rule', 'above\n\n---\n\nbelow'],
    ['strikethrough', 'This is ~~gone~~.'],
    ['paragraphs', 'First para.\n\nSecond para.'],
  ]

  for (const [name, input] of cases) {
    it(name, () => {
      const out = expectIdempotent(input)
      expect(out.trim().length).toBeGreaterThan(0)
    })
  }

  it('keeps code block content and language exactly', () => {
    const out = roundTrip('```python\nx = [1, 2, 3]\nprint(x)\n```')
    expect(out).toContain('```python')
    expect(out).toContain('x = [1, 2, 3]')
    expect(out).toContain('print(x)')
  })

  it('preserves checkbox state', () => {
    const out = roundTrip('- [ ] todo\n- [x] finished')
    expect(out).toContain('[ ]')
    expect(out).toContain('[x]')
  })

  it('does not mangle an agent-written body on open-and-save with no edits', () => {
    const agentWritten = [
      '## What happened',
      '',
      'The pooler caps at 15 regardless of client config.',
      '',
      '- [x] reproduced with 50 clients',
      '- [ ] confirm in prod',
      '',
      '```',
      'POSTGRES_PORT=5432',
      '```',
    ].join('\n')
    expectIdempotent(agentWritten)
  })
})

describe('documented lossiness — these are the trade-offs, not bugs', () => {
  // richEditLoss routes a body with any of these to the markdown textarea, so
  // a human edit never takes it through this trip. These pin the trip itself.
  it('drops raw HTML rather than corrupting it (html: false)', () => {
    const out = roundTrip('Before <span class="x">inline</span> after.')
    expect(out).not.toContain('<span')
  })

  it('normalises list markers to a single style', () => {
    expect(roundTrip('* star\n* markers')).toContain('- star')
  })

  it('normalises setext headings to ATX', () => {
    expect(roundTrip('Title\n=====')).toContain('# Title')
  })
})

describe('GFM tables survive the round trip', () => {
  /** A table is only safe if it comes back byte-for-byte, not merely stable. */
  const exact: [string, string][] = [
    ['simple', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['alignment', '| Left | Centre | Right | None |\n| :--- | :---: | ---: | --- |\n| l | c | r | n |'],
    ['inline code and bold in cells', '| Code | Emphasis |\n| --- | --- |\n| `SELECT 1` | **strong** and *em* |'],
    ['escaped pipes in text', '| a \\| b | c |\n| --- | --- |\n| 1 \\| 2 | 3 |'],
    ['escaped pipe inside a code span', '| Flag | Meaning |\n| --- | --- |\n| `a \\| b` | either |'],
    ['links and strikethrough in cells', '| Link | Gone |\n| --- | --- |\n| [docs](https://example.com) | ~~old~~ |'],
    ['empty cell', '| a | b |\n| --- | --- |\n|  | 2 |'],
    ['header only', '| a | b |\n| --- | --- |'],
    ['between paragraphs', 'Before.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.'],
    ['inside a blockquote', '> | a | b |\n> | --- | --- |\n> | 1 | 2 |'],
  ]

  for (const [name, input] of exact) {
    it(name, () => {
      expect(roundTrip(input)).toBe(input)
      expectIdempotent(input)
    })
  }

  it('normalises the delimiter row, keeping each column\'s alignment', () => {
    expect(roundTrip('| a | b | c |\n|:-|-:|:-:|\n| 1 | 2 | 3 |')).toBe(
      '| a | b | c |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |',
    )
  })

  it('pads a short row with empty cells', () => {
    expect(roundTrip('| a | b |\n| --- | --- |\n| 1 |')).toBe('| a | b |\n| --- | --- |\n| 1 |  |')
  })

  it('keeps the pipe in a cell as a cell, not a column', () => {
    const out = roundTrip('| a \\| b | c |\n| --- | --- |\n| 1 | 2 |')
    expect(out.split('\n')[1]).toBe('| --- | --- |')
  })

  it('keeps an agent-written body with a table byte-stable', () => {
    const agentWritten = [
      '## Options',
      '',
      '| Option | Cost | Risk |',
      '| :--- | ---: | --- |',
      '| Pooler | `$0` | **pins** at 15 |',
      '| Direct | `$40` | none |',
      '',
      '- [ ] pick one',
    ].join('\n')
    expect(roundTrip(agentWritten)).toBe(agentWritten)
  })
})

describe('richEditLoss', () => {
  it('lets a table through now that it round-trips', () => {
    expect(richEditLoss('| a | b |\n| :-- | --: |\n| `x \\| y` | **2** |')).toBeNull()
  })

  it('flags a table row with more cells than its header', () => {
    expect(richEditLoss('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |')).toMatch(/more cells/)
    expect(richEditLoss('> | a |\n> | --- |\n> | 1 | 2 |')).toMatch(/more cells/)
  })

  it('does not count escaped pipes as cells', () => {
    expect(richEditLoss('| a | b |\n| --- | --- |\n| 1 \\| 2 | 3 |')).toBeNull()
  })

  it('flags raw HTML, including comments and void tags', () => {
    expect(richEditLoss('Before <details><summary>x</summary>y</details>')).toMatch(/HTML/)
    expect(richEditLoss('Line<br/>break')).toMatch(/HTML/)
    expect(richEditLoss('Text <!-- note --> more')).toMatch(/HTML/)
  })

  it('flags headings the schema has no level for, and footnotes', () => {
    expect(richEditLoss('#### Deep')).toMatch(/heading/)
    expect(richEditLoss('Claim[^1].\n\n[^1]: source')).toMatch(/footnote/)
  })

  it('ignores HTML, headings and pipes inside code', () => {
    expect(richEditLoss('```\n<div>\n#### not a heading\n```\n\nPlain text.')).toBeNull()
    expect(richEditLoss('- item\n\n  ```html\n  <div>\n  ```')).toBeNull()
    expect(richEditLoss('Use `<T>` and ``a ` <b>`` here.')).toBeNull()
  })

  it('passes ordinary prose, autolinks and comparisons', () => {
    expect(richEditLoss('## Why\n\n- one | two\n- see <https://example.com>\n- 1 < 2')).toBeNull()
  })

  it('flags nothing the round trip keeps', () => {
    const body = '## Plan\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [x] done'
    expect(richEditLoss(body)).toBeNull()
    expect(roundTrip(body)).toBe(body)
  })

  it('flags everything the round trip loses', () => {
    for (const body of ['<span>x</span>', '#### Four', 'a[^1]\n\n[^1]: b', '| a |\n| --- |\n| 1 | 2 |']) {
      expect(richEditLoss(body)).not.toBeNull()
      expect(roundTrip(body)).not.toBe(body)
    }
  })
})

describe('tables beyond the byte-for-byte cases', () => {
  it('keeps an image in a cell', () => {
    const body = '| Shot | Note |\n| --- | --- |\n| ![login](https://x.y/a.png) | before |'
    expect(roundTrip(body)).toBe(body)
    expect(richEditLoss(body)).toBeNull()
  })

  it('writes a table without outer pipes with them', () => {
    expect(roundTrip('a | b\n--- | ---\n1 | 2')).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(richEditLoss('a | b\n--- | ---\n1 | 2')).toBeNull()
  })

  it('keeps a table off the rich editor where it cannot check the round trip', () => {
    vi.stubGlobal('document', undefined)
    try {
      expect(richEditLoss('| a | b |\n| --- | --- |\n| 1 | 2 |')).toMatch(/table/)
      expect(richEditLoss('## No table here')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

import { describe, expect, it } from 'vitest'
import { bodyProblems, MAX_BARE_CODE, UNSTRUCTURED_BODY, WALL_PARAGRAPH } from './markdown-body'

/** A real body an agent filed, trimmed. Every rule has something to say about it. */
const WALL = `Feasibility answered 2026-09-29 (no code yet).
WHY EMPTY TODAY: hermes Production → Appels = call.controller.search (hermes src/app/_server/db/controllers/call.controller.js:303-304): non-managers (roles.hermes ∉ MANAGER_ROLES) get aircallCall.internalUserId = me. CS calls carry internalUserId = mutuelle@ (659d6acf…) or nothing (dispofi-ai only writes aircallCall.internalUserId when dealId && qualifyingData; analyseCall.js maps ...) ...
PROPOSED (query-time, hermes only, no pipeline change, no backfill): for users with roles.hermes = CUSTOMER_SERVICE and an aircallUserId, match { 'user.id': Number(aircallUserId) } instead ...`

/** The same facts, written as markdown. */
const REWRITTEN = `Feasibility answered 2026-09-29 (no code yet).

## Why empty today

hermes Production → Appels is \`call.controller.search\`
(\`src/app/_server/db/controllers/call.controller.js:303-304\`):

- Non-managers (\`roles.hermes\` ∉ \`MANAGER_ROLES\`) get \`aircallCall.internalUserId = me\`.
- CS calls carry \`internalUserId\` = mutuelle@ (\`659d6acf…\`) or nothing: dispofi-ai only
  writes \`aircallCall.internalUserId\` when \`dealId && qualifyingData\`; \`analyseCall.js\` maps …

## Proposed

Query-time, hermes only, no pipeline change, no backfill.

For users with \`roles.hermes = CUSTOMER_SERVICE\` and an \`aircallUserId\`, match
\`{ 'user.id': Number(aircallUserId) }\` instead.
`

const prose = (words: number) =>
  Array.from({ length: words }, (_, i) => (i % 12 === 11 ? 'done.' : 'word')).join(' ')

describe('bodyProblems: the body that prompted it (CROFT-312)', () => {
  const problems = bodyProblems(WALL)

  it('turns each shouted label into the heading it should be', () => {
    expect(problems).toContain(
      '"WHY EMPTY TODAY:" is a label shouted in capitals — make it a heading on its own line: "## Why empty today".',
    )
    expect(problems.find((p) => p.startsWith('"PROPOSED ('))).toContain('"## Proposed"')
  })

  it('calls the single paragraph a wall, and the body unstructured', () => {
    expect(problems.some((p) => /^A 6\d\d-character paragraph \("Feasibility answered/.test(p))).toBe(true)
    expect(problems.some((p) => p.includes('no heading, list or code block'))).toBe(true)
  })

  it('names the code loose in the prose, in reading order, capped', () => {
    const bare = problems.filter((p) => p.startsWith('Wrap '))
    expect(bare).toEqual([
      'Wrap `call.controller.search` in backticks — it is code.',
      'Wrap `src/app/_server/db/controllers/call.controller.js:303-304` in backticks — it is code.',
      'Wrap `MANAGER_ROLES` in backticks — it is code.',
      'Wrap `aircallCall.internalUserId` in backticks — it is code.',
      'Wrap `analyseCall.js` in backticks — it is code.',
    ])
    expect(bare).toHaveLength(MAX_BARE_CODE)
    expect(problems.at(-1)).toMatch(/^…and 2 more like them/)
  })

  it('passes once the same facts are written as markdown', () => {
    expect(bodyProblems(REWRITTEN)).toEqual([])
  })
})

describe('bodyProblems: what passes', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   \n  '],
    ['one line', 'Clicking save drops the draft; expected it to persist. Repro: edit, save, reload.'],
    ['a short note with a ref', 'CROFT-291: moved the body rule into the API. See the thread.'],
    ['inline markers', 'TODO: check the staging logs.\nNOTE: the cron runs at 10:30.\nJSON: the payload is fine.'],
    ['prose abbreviations and versions', 'Upgrade to v1.2.3, e.g. via npm; i.e. the U.S.A. mirror. Node.js and Next.js 14.2 are fine.'],
    ['URLs, emails and links', 'See https://example.com/a/b.js?x=1, mail ops@example.com, or [the spec](./docs/spec.md).'],
    ['plural parentheticals', 'The agent(s) that filed the task(s) should re-check.'],
    ['a sentence-case label', 'Why: the pool is capped at 15.'],
    ['a table', '| file | why |\n|---|---|\n| a | b |'],
  ])('%s', (_name, body) => {
    expect(bodyProblems(body)).toEqual([])
  })

  it('a long body split into headings, lists and short paragraphs', () => {
    const body = [
      '## What happens',
      '',
      prose(60),
      '',
      prose(60),
      '',
      '## Steps',
      '',
      `- ${prose(40)}`,
      `- ${prose(40)}`,
    ].join('\n')
    expect(body.length).toBeGreaterThan(UNSTRUCTURED_BODY)
    expect(bodyProblems(body)).toEqual([])
  })

  it('a long list item is a list, not a wall', () => {
    expect(bodyProblems(`- ${prose(150)}\n  ${prose(40)}`)).toEqual([])
  })
})

describe('bodyProblems: code is exempt', () => {
  it('ignores everything inside a fenced block', () => {
    const body = [
      'The failing call:',
      '',
      '```js',
      'WHY EMPTY TODAY: call.controller.search(req) // src/a/b.js:303',
      `const x = "${'y'.repeat(700)}\\n"`,
      '```',
    ].join('\n')
    expect(bodyProblems(body)).toEqual([])
  })

  it('counts a fenced block as structure, and an unclosed fence runs to the end', () => {
    expect(bodyProblems(`${prose(50)}\n\n~~~\n${prose(80)}`)).toEqual([])
  })

  it('ignores inline code, including a span that wraps onto the next line', () => {
    expect(bodyProblems('The fix is in `src/a/b.ts:12` and `resolve(x)`, via `a.b.c` and `SOME_FLAG`.')).toEqual([])
    expect(bodyProblems('Run `croft sync --also skill=<path>/croft/\nSKILL.md` once.')).toEqual([])
    expect(bodyProblems('A ``double `tick` span with call.site.here()`` is still code.')).toEqual([])
  })
})

describe('bodyProblems: each rule on its own', () => {
  it('a shouted label, with or without bold, whatever the body length', () => {
    expect(bodyProblems('ROOT CAUSE: the pool is capped.')).toEqual([
      '"ROOT CAUSE:" is a label shouted in capitals — make it a heading on its own line: "## Root cause".',
    ])
    expect(bodyProblems('**NEXT STEPS:** ship it')[0]).toContain('"## Next steps"')
    expect(bodyProblems('PLAN: ship it')[0]).toContain('"## Plan"')
  })

  it('not inside a list item, a heading or a quote', () => {
    expect(bodyProblems('- WHY: because\n## WHY: heading\n> NOTE WELL: quoted')).toEqual([])
    expect(bodyProblems('- an item that wraps and whose next line starts with\n  UPDATE: the SQL keyword')).toEqual([])
  })

  it('literal \\n escapes', () => {
    expect(bodyProblems('First line.\\nSecond line.\\n\\nThird.')).toEqual([
      '3 literal "\\n" escapes — send real line breaks, not a backslash and an n.',
    ])
  })

  it('a wall paragraph, even inside an otherwise structured body', () => {
    const wall = prose(130)
    expect(wall.length).toBeGreaterThan(WALL_PARAGRAPH)
    const problems = bodyProblems(`## Context\n\n${wall}\n\n- one\n- two`)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/^A \d{3}-character paragraph \("word word/)
  })

  it('a long unstructured body made of short paragraphs', () => {
    const body = [prose(50), prose(50), prose(50)].join('\n\n')
    expect(bodyProblems(body)).toEqual([
      expect.stringMatching(/^\d{3} characters with no heading, list or code block/),
    ])
  })

  it('bare paths, calls and identifiers', () => {
    expect(bodyProblems('Broken in ./lib/pool.ts and ~/cfg/app.yaml:4, see README.md.')).toEqual([
      'Wrap `./lib/pool.ts` in backticks — it is code.',
      'Wrap `~/cfg/app.yaml:4` in backticks — it is code.',
      'Wrap `README.md` in backticks — it is code.',
    ])
    expect(bodyProblems('It calls resolveAssignee(body.assignee, actor.userId) then search().')).toEqual([
      'Wrap `resolveAssignee(body.assignee, actor.userId)` in backticks — it is code.',
      'Wrap `search()` in backticks — it is code.',
    ])
    expect(bodyProblems('Set claimed_by from window.claude.ask and read actor.userId.')).toEqual([
      'Wrap `claimed_by` in backticks — it is code.',
      'Wrap `window.claude.ask` in backticks — it is code.',
      'Wrap `actor.userId` in backticks — it is code.',
    ])
  })

  it('names each bare snippet once', () => {
    expect(bodyProblems('db.pool.max here, db.pool.max there')).toEqual(['Wrap `db.pool.max` in backticks — it is code.'])
  })
})

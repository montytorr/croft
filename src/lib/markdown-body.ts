/**
 * Whether a task body reads as markdown or as a wall of text (CROFT-312).
 *
 * Agents filed bodies like "WHY EMPTY TODAY: hermes Production → Appels =
 * call.controller.search (hermes src/…/call.controller.js:303-304): non-managers
 * …" — one paragraph, labels shouted in capitals where headings belong, and
 * paths and calls loose in the prose. Every fact was there and none of it was
 * findable. The page renders markdown; the body just was not written in it.
 *
 * Each problem is one instruction the writer can carry out, quoting what it is
 * about. HOL-57 learned why: an agent told only that its input is invalid has
 * no next step and invents one. Code — fenced blocks and inline spans — is
 * never checked, because it is already what the rules ask for.
 */

/** Under this, a body is a line or two: only the spelling rules apply. */
export const SHORT_BODY = 200
/**
 * One prose paragraph past this is a wall: about a hundred words. Set above
 * where this repository's own hand-written docs usually sit, 500 to 580.
 */
export const WALL_PARAGRAPH = 600
/** Past this, a body with no heading, list, table or code block is unstructured. */
export const UNSTRUCTURED_BODY = 600
/** Enough to show the pattern; the rest is the same fix. */
export const MAX_BARE_CODE = 5

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/
const TABLE_ROW = /^\s*\|/
const QUOTE = /^\s{0,3}>/
/** `[1]: https://…` — where a reference-style link points. */
const LINK_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s/

// Stand-ins for what the rules must not look inside. Neither is an ASCII word
// character, so a masked span also ends whatever word it touched.
const CODE_MASK = 'ℂ'
const LINK_MASK = 'ℒ'

// Code spans and links may wrap onto the next line, but never across a blank
// one: that ends the paragraph they are in.
const INLINE_CODE = /(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g
const MARKDOWN_LINK = /!?\[(?:[^\][]|\[[^\]]*\])*\]\([^)]*\)/g
const AUTOLINK = /<[^>\s]+>/g
const URL = /\b(?:https?|ftp|file|ssh|git):\/\/[^\s)>\]]+/gi
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

/** Replaces a span with a mask, keeping its line breaks so lines stay aligned. */
const blank = (mask: string) => (span: string) => span.replace(/[^\n]+/g, mask)

/** The prose lines with code, links, URLs and addresses masked out. */
const maskProse = (lines: string[]) =>
  lines
    .join('\n')
    .replace(INLINE_CODE, blank(CODE_MASK))
    .replace(MARKDOWN_LINK, blank(LINK_MASK))
    .replace(AUTOLINK, LINK_MASK)
    .replace(URL, LINK_MASK)
    .replace(EMAIL, LINK_MASK)
    .split('\n')

const quote = (text: string, max = 48) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

const count = (n: number) => n.toLocaleString('en-US')

/**
 * The body with fenced code blocks blanked out, line for line.
 *
 * A blank line where a fence was keeps paragraphs on either side apart, which
 * is how they render. An unclosed fence runs to the end, as it does on the page.
 */
const outsideFences = (text: string) => {
  let fence: string | null = null
  let hasCodeBlock = false
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const marker = FENCE_OPEN.exec(line)?.[1]
    if (fence !== null) {
      const closes =
        marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker
      if (closes) fence = null
      return ''
    }
    if (marker) {
      fence = marker
      hasCodeBlock = true
      return ''
    }
    return line
  })
  return { lines, hasCodeBlock }
}

// --- rule 1: a label in capitals where a heading belongs --------------------

const CAPS_WORD = "[A-Z]+(?:['’/&-][A-Z]+)*"
const SHOUTED = new RegExp(
  `^(?:\\*\\*|__)?(${CAPS_WORD}(?:[ \\t]+${CAPS_WORD})*)[ \\t]*(\\([^)\\n]*\\))?[ \\t]*:(?:\\*\\*|__)?(?=\\s|$)`,
)

/**
 * Words that open a line in capitals without being a heading: inline markers,
 * and the acronyms a sentence can start with.
 */
const NOT_A_HEADING = new Set([
  'TODO', 'FIXME', 'XXX', 'HACK', 'NOTE', 'NB', 'PS', 'TLDR', 'OK', 'FYI', 'EDIT',
  'API', 'CLI', 'CSS', 'CSV', 'DNS', 'HTML', 'HTTP', 'HTTPS', 'JSON', 'JWT', 'MCP', 'SQL',
  'SSH', 'SSL', 'TLS', 'UI', 'URL', 'UUID', 'YAML', 'AWS', 'GCP', 'CI', 'PR', 'QA',
])

const sentenceCase = (words: string) => {
  const lower = words.replace(/\s+/g, ' ').toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

const shoutedLabel = (masked: string): string | null => {
  const [, phrase, aside] = SHOUTED.exec(masked.trim()) ?? []
  if (!phrase) return null
  const words = phrase.split(/\s+/)
  if (words.every((w) => w.length < 2)) return null
  const [only] = words
  if (words.length === 1 && only && (only.length < 3 || NOT_A_HEADING.has(only))) return null
  const label = `${phrase}${aside ? ` (${quote(aside.slice(1, -1), 24)})` : ''}:`
  return (
    `"${label}" is a label shouted in capitals — make it a heading on its own line: ` +
    `"## ${sentenceCase(phrase)}"${aside ? ', with the part in brackets as the first line under it' : ''}.`
  )
}

// --- rule 5: code loose in the prose ----------------------------------------

const EXTENSIONS = [
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'swift', 'cpp', 'hpp', 'cs', 'php', 'sql', 'sh', 'bash', 'zsh', 'json', 'jsonl', 'yml',
  'yaml', 'toml', 'md', 'mdx', 'css', 'scss', 'sass', 'less', 'html', 'vue', 'svelte',
  'prisma', 'graphql', 'gql', 'proto', 'tf', 'ini', 'conf', 'cfg', 'xml', 'lock',
].join('|')

/** `src/a/b.js:303-304`, `./x.ts`, `call.controller.js`. */
const FILE_PATH = new RegExp(
  `(?<![\\w@./~-])(?:~|\\.{1,2})?/?(?:[\\w@.-]+/)*[\\w-][\\w.-]*\\.(?:${EXTENSIONS})(?::\\d+(?:[-–]\\d+)?)?(?![\\w/])`,
  'g',
)
/** `Node.js`, `Next.js`: products, not files. */
const PRODUCT_NAME = /^[A-Z][A-Za-z0-9]*\.js$/

/** `resolveAssignee(x)`, `search()`, `Number(aircallUserId)`. One level of nesting. */
const CALL = /(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(((?:[^()\n]|\([^()\n]*\)){0,80})\)/g
/** "call(s)", "quick(ish)": English, not code. */
const PROSE_SUFFIX = /^(?:s|es|ies|ish|ed|er|ly)$/i

/** `call.controller.search` — three segments or more. */
const DOTTED = /(?<![\w$.])[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){2,}(?![\w$])/g
/** `actor.userId` — two segments, only when one of them could not be prose. */
const DOTTED_PAIR = /(?<![\w$.])[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*(?![\w$])/g
/** `MANAGER_ROLES`, `claimed_by`. */
const SNAKE = /(?<![\w$.])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?![\w$])/g

const CAMEL_HUMP = /[a-z][A-Z]/
const hasCodeShape = (name: string) => /[._$]/.test(name) || CAMEL_HUMP.test(name)

type Keep = (match: RegExpExecArray) => boolean

const FINDERS: [RegExp, Keep][] = [
  [FILE_PATH, (m) => !PRODUCT_NAME.test(m[0])],
  [CALL, ([, name = '', args = '']) => !PROSE_SUFFIX.test(args) && (hasCodeShape(name) || !/\s/.test(args))],
  [DOTTED, (m) => !m[0].split('.').every((part) => part.length === 1)],
  [DOTTED_PAIR, (m) => m[0].split('.').some((part) => CAMEL_HUMP.test(part) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(part))],
  [SNAKE, () => true],
]

/**
 * Code-shaped runs in one line of masked prose, in reading order.
 *
 * Each finder blanks what it took, so a path is not also reported as the
 * dotted identifier inside it.
 */
const bareCodeIn = (masked: string): string[] => {
  let rest = masked
  const found: { at: number; text: string }[] = []
  for (const [pattern, keep] of FINDERS) {
    let blanked = ''
    let from = 0
    for (const match of rest.matchAll(pattern)) {
      if (!keep(match)) continue
      const at = match.index ?? 0
      found.push({ at, text: match[0] })
      blanked += rest.slice(from, at) + CODE_MASK.repeat(match[0].length)
      from = at + match[0].length
    }
    rest = blanked + rest.slice(from)
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.text)
}

// --- the checks --------------------------------------------------------------

type Kind = 'blank' | 'heading' | 'table' | 'quote' | 'definition' | 'list' | 'prose'

const BLOCKS: [RegExp, Kind][] = [
  [HEADING, 'heading'],
  [TABLE_ROW, 'table'],
  [QUOTE, 'quote'],
  [LINK_DEFINITION, 'definition'],
  [LIST_ITEM, 'list'],
]

/**
 * What each line is, as the page will render it.
 *
 * A line straight after a list item continues that item, indented or not, so
 * it is list and not prose; a blank line ends the item.
 */
const classify = (lines: string[]): Kind[] => {
  let inList = false
  return lines.map((line) => {
    const block = BLOCKS.find(([pattern]) => pattern.test(line))?.[1]
    const kind: Kind = !line.trim() ? 'blank' : (block ?? (inList ? 'list' : 'prose'))
    inList = kind === 'list'
    return kind
  })
}

/** Prose paragraphs: runs of prose lines, joined as the page joins them. */
const paragraphsOf = (lines: string[], kinds: Kind[]) => {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const [i, line] of lines.entries()) {
    if (kinds[i] === 'prose') {
      current.push(line.trim())
    } else if (current.length > 0) {
      paragraphs.push(current.join(' '))
      current = []
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '))
  return paragraphs
}

/**
 * What would make this body readable, as instructions. Empty means it is fine.
 *
 * Five rules: shouted labels where headings belong, literal `\n` escapes, a
 * paragraph long enough to be a wall, a long body with no structure at all,
 * and code loose in the prose. A body under {@link SHORT_BODY} characters is
 * a line or two, so only the three about spelling apply to it.
 */
export const bodyProblems = (text: string): string[] => {
  if (!text.trim()) return []
  const { lines, hasCodeBlock } = outsideFences(text)
  const masked = maskProse(lines)
  const kinds = classify(lines)
  const problems: string[] = []

  for (const [i, line] of masked.entries()) {
    const label = kinds[i] === 'prose' ? shoutedLabel(line) : null
    if (label) problems.push(label)
  }

  const escapes = masked.join('\n').match(/\\n/g)?.length ?? 0
  if (escapes > 0) {
    problems.push(
      `${escapes} literal "\\n" ${escapes === 1 ? 'escape' : 'escapes'} — send real line breaks, ` +
        'not a backslash and an n.',
    )
  }

  const prose = lines.join('\n').trim()
  if (prose.length >= SHORT_BODY) {
    const walls = paragraphsOf(lines, kinds).filter((p) => p.length > WALL_PARAGRAPH)
    for (const wall of walls.slice(0, 3)) {
      problems.push(
        `A ${count(wall.length)}-character paragraph ("${quote(wall)}") is a wall of text — ` +
          'break it into a list, or paragraphs of two or three sentences.',
      )
    }

    const structured = hasCodeBlock || kinds.some((k) => k === 'heading' || k === 'list' || k === 'table')
    if (prose.length > UNSTRUCTURED_BODY && !structured) {
      problems.push(
        `${count(prose.length)} characters with no heading, list or code block — give each part ` +
          'a "## " heading (what happens, why, what to do) and put steps and findings in "- " lists.',
      )
    }
  }

  const bare = [...new Set(masked.flatMap(bareCodeIn))]
  for (const code of bare.slice(0, MAX_BARE_CODE)) {
    problems.push(`Wrap \`${quote(code, 80)}\` in backticks — it is code.`)
  }
  if (bare.length > MAX_BARE_CODE) {
    problems.push(
      `…and ${bare.length - MAX_BARE_CODE} more like them: every path, call and identifier in prose goes in backticks.`,
    )
  }

  return problems
}

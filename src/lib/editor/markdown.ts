import { Editor, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Markdown, type MarkdownNodeSpec } from 'tiptap-markdown'

type SerializerState = Parameters<MarkdownNodeSpec['serialize']>[0]

/**
 * prosemirror-markdown keeps a state's node and mark serialisers internal, but
 * a cell has to be rendered by a state of its own (see below), built from them.
 */
type StateInternals = {
  nodes: unknown
  marks: unknown
  options: SerializerState['options']
  out: string
  render: (node: PMNode, parent: PMNode, index: number) => void
}
type StateClass = new (nodes: unknown, marks: unknown, options: unknown) => StateInternals

/**
 * One cell's markdown, on one line, with its pipes escaped.
 *
 * Rendered by a fresh state rather than the table's: tiptap-markdown's state
 * records mark positions in its output buffer and trims whitespace at them
 * after each block, so writing a cell into a borrowed buffer shifted a later
 * trim onto the delimiter row. GFM splits a row on `|` before it parses
 * inlines, so a pipe must be `\|` everywhere in a cell, code spans included.
 * A cell cannot hold a line break or a second block either, so both become a
 * space rather than the `[hardBreak]` placeholder tiptap-markdown writes in a
 * table with html off.
 */
const cellMarkdown = (state: SerializerState, cell: PMNode): string => {
  const { nodes, marks, options, constructor } = state as unknown as StateInternals
  const sub = new (constructor as StateClass)(nodes, marks, options)
  cell.forEach((block, _offset, index) => sub.render(block, cell, index))
  return sub.out
    .replace(/\\\n/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
    .replace(/\|/g, '\\|')
}

const DELIMITER = { left: ':---', center: ':---:', right: '---:' } as const

const columnAlign = (rows: PMNode[], column: number): keyof typeof DELIMITER | null => {
  for (const row of rows) {
    const align: unknown = row.maybeChild(column)?.attrs.align
    if (align === 'left' || align === 'center' || align === 'right') return align
  }
  return null
}

/**
 * tiptap-markdown's own table serialiser drops column alignment, leaves `|`
 * in a cell unescaped (which splits the cell on the next parse), and writes
 * the literal `[table]` for any table it considers non-GFM once html is off.
 * This one always writes a pipe table: the first row is the header, spans
 * are laid out as empty cells, and alignment is kept from the cells' `align`.
 * Ported from Cairn (CAIRN-326), which found each of those the hard way.
 */
const GfmTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode) {
          const rows: PMNode[] = []
          node.forEach((row) => rows.push(row))
          const cells = rows.map((row) => {
            const out: string[] = []
            row.forEach((cell) => {
              const span = Math.max(1, Number(cell.attrs.colspan ?? 1))
              out.push(cellMarkdown(state, cell), ...Array<string>(span - 1).fill(''))
            })
            return out
          })
          const width = Math.max(1, ...cells.map((row) => row.length))
          const line = (row: string[]) =>
            `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`
          const delimiters = Array.from({ length: width }, (_, column) => {
            const align = columnAlign(rows, column)
            return align ? DELIMITER[align] : '---'
          })
          const [header = [], ...body] = cells
          const lines = [line(header), `| ${delimiters.join(' | ')} |`, ...body.map(line)]
          // No newline after the last row: closeBlock separates the table from
          // what follows, so a body that ends in one stays byte-stable.
          lines.forEach((text, index) => {
            if (index) state.ensureNewLine()
            state.write(text)
          })
          state.closeBlock(node)
        },
        parse: {
          // markdown-it parses GFM tables; its HTML carries text-align, which
          // the cell extensions read into `align`.
        },
      } satisfies MarkdownNodeSpec,
    }
  },
})

/**
 * The editor's extension set is deliberately constrained to constructs that
 * map 1:1 onto GFM, tables included.
 *
 * Markdown is the source of truth in `tasks.description`, because agents read
 * and write it over the API. Tiptap is WYSIWYG over a ProseMirror document, so
 * every human edit round-trips markdown -> doc -> markdown. Anything outside
 * this schema is lossy on that trip, so the schema is kept to exactly what
 * GFM can express — and what it cannot express is documented rather than
 * silently mangled.
 */
export const editorExtensions = (): Extensions => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    // Rendered as `---`; kept because agents use it as a section break.
    horizontalRule: {},
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  // Not in StarterKit. Without it a markdown image is dropped on the round
  // trip, which would silently delete screenshot references from bodies an
  // agent wrote. Found by the fidelity spike, not by reading the docs.
  Image.configure({ inline: false, allowBase64: false }),
  // GFM tables. Column widths are not markdown, so resizing is off rather
  // than offering a width that the next save would throw away.
  GfmTable.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Markdown.configure({
    html: false, // raw HTML is not round-trippable; drop it rather than corrupt it
    tightLists: true,
    bulletListMarker: '-',
    linkify: false,
    breaks: false,
    transformPastedText: true,
  }),
]

/**
 * tiptap-markdown adds `storage.markdown` at runtime but ships no type for it,
 * so declare it rather than casting at each call site. `parser.md` is the
 * markdown-it instance it parses with, configured as above.
 */
declare module '@tiptap/core' {
  interface Storage {
    markdown: { getMarkdown: () => string; parser: { md: { render: (markdown: string) => string } } }
  }
}

/** Headless editor, for serialisation and tests. Requires a DOM. */
export const headlessEditor = (markdown: string) =>
  new Editor({ extensions: editorExtensions(), content: markdown })

const FENCED = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm
const INLINE_CODE = /(`+)[\s\S]*?\1/g
const RAW_HTML = /<(\/?[a-z][a-z0-9-]*(\s[^>]*)?\/?>|!--)/i
const DEEP_HEADING = /^ {0,3}#{4,6}(\s|$)/m
const FOOTNOTE = /\[\^[^\]\s]+\]/
const TABLE_DELIMITER = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/
const TABLE_HTML = /<table[\s\S]*?<\/table>/g

const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)

/** Each line with its blockquote markers stripped, so a quoted table is checked too. */
const unquoted = (prose: string) => prose.split('\n').map((line) => line.replace(/^\s*(>\s?)*\s*/, ''))

/** Where a table's delimiter row is: a `---|---` line under a line with a pipe. */
const isDelimiterRow = (lines: string[], index: number) => {
  const line = lines[index] ?? ''
  return index > 0 && line.includes('|') && TABLE_DELIMITER.test(line) && Boolean(lines[index - 1]?.includes('|'))
}

/**
 * GFM keeps only as many cells in a row as the header has, so the extras are
 * invisible when rendered and gone after a rich edit.
 */
const hasOverfullTableRow = (prose: string): boolean => {
  const lines = unquoted(prose)
  return lines.some((delimiter, index) => {
    if (!isDelimiterRow(lines, index)) return false
    const width = tableCells(delimiter).length
    const end = lines.findIndex((line, at) => at > index && !line.trim())
    return lines
      .slice(index + 1, end === -1 ? undefined : end)
      .some((row) => tableCells(row).length > width)
  })
}

/** Every table in a document, as the renderer draws it. */
const tablesOf = (render: (markdown: string) => string, markdown: string) =>
  (render(markdown).match(TABLE_HTML) ?? []).map((table) => table.replace(/>\s+</g, '><'))

/**
 * Whether every table comes back from the round trip as the same table: the
 * same HTML before and after. Spelling may change (`:-` becomes `:---`, outer
 * pipes appear); cells, content and alignment may not. The rule the checks
 * above approximate, run for real — so a loss nobody has named yet still
 * keeps the body out of the rich editor. It needs a DOM; without one, it
 * assumes the worst.
 */
const tablesSurvive = (markdown: string): boolean => {
  if (typeof document === 'undefined') return false
  let editor: Editor | undefined
  try {
    editor = headlessEditor(markdown)
    const render = (md: string) => editor!.storage.markdown.parser.md.render(md)
    const before = tablesOf(render, markdown)
    const after = tablesOf(render, editor.storage.markdown.getMarkdown())
    return before.length === after.length && before.every((table, i) => table === after[i])
  } catch {
    return false
  } finally {
    editor?.destroy()
  }
}

/**
 * Why the rich editor would lose part of this markdown, or null when it would not.
 *
 * Tables round-trip (see GfmTable above), but the schema has limits a body can
 * still cross: raw HTML is dropped on purpose, and a few GFM constructs have no
 * node. A body that crosses one is edited as markdown instead, so a human
 * edit never rewrites what an agent wrote. Code is ignored: `<div>` or a
 * `####` inside a fence or a code span is text.
 */
export const richEditLoss = (markdown: string): string | null => {
  const prose = markdown.replace(FENCED, '').replace(INLINE_CODE, '')
  if (RAW_HTML.test(prose)) return 'It has raw HTML, which the rich editor would drop.'
  if (DEEP_HEADING.test(prose)) return 'It has a heading below level 3, which the rich editor would flatten.'
  if (FOOTNOTE.test(prose)) return 'It has a footnote, which the rich editor would break.'
  if (hasOverfullTableRow(prose)) {
    return 'A table row has more cells than its header, and the rich editor would drop the extras.'
  }
  const lines = unquoted(prose)
  if (lines.some((_, index) => isDelimiterRow(lines, index)) && !tablesSurvive(markdown)) {
    return 'It has a table the rich editor cannot keep exactly.'
  }
  return null
}

/** markdown -> ProseMirror -> markdown. The trip a human edit makes. */
export const roundTrip = (markdown: string): string => {
  const editor = headlessEditor(markdown)
  const out = editor.storage.markdown.getMarkdown()
  editor.destroy()
  return out
}

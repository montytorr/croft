import { visit, SKIP } from 'unist-util-visit'

/**
 * Bare subject refs like `S-12`. A single letter on purpose (see the contract):
 * it cannot be mistaken for a Cairn project key, and nothing else in prose
 * looks like `S-` followed by digits often enough to be worth guarding.
 */
const REF = /\bS-(\d{1,7})\b/g

type TextNode = { type: 'text'; value: string }
type LinkNode = {
  type: 'link'
  url: string
  data: { hProperties: Record<string, string> }
  children: TextNode[]
}
type Parent = { type: string; children: unknown[] }

/**
 * Turns bare subject refs in prose into in-app links, so a write-up that says
 * "supersedes S-4" or a log entry that says "see S-9" can be followed. Marked
 * with `data-task-ref`, which is what MarkdownView reads as "route in-app".
 */
export const remarkSubjectRefs = () => (tree: unknown) => {
  visit(tree as Parent, 'text', (node: unknown, index: number | undefined, parent: Parent | undefined) => {
    if (!parent || index === undefined) return
    if (parent.type === 'link' || parent.type === 'linkReference') return

    const value = (node as TextNode).value
    const out: (TextNode | LinkNode)[] = []
    let cursor = 0

    for (const match of value.matchAll(REF)) {
      const [full, number] = match
      if (!number) continue
      const at = match.index
      if (at > cursor) out.push({ type: 'text', value: value.slice(cursor, at) })
      out.push({
        type: 'link',
        url: `/subjects/${number}`,
        data: { hProperties: { 'data-task-ref': full } },
        children: [{ type: 'text', value: full }],
      })
      cursor = at + full.length
    }

    if (out.length === 0) return
    if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) })
    parent.children.splice(index, 1, ...out)
    return [SKIP, index + out.length]
  })
}

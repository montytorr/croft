export type OutlineEntry = { level: 1 | 2 | 3; text: string }

const FENCE = /^[ \t]*(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/

/** A heading's text as it reads, without its inline markdown. */
const plain = (text: string) =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .trim()

/**
 * The write-up's headings, levels 1 to 3, in order: the outline beside it.
 * A `#` inside a fenced block is code, not a section.
 */
export const outlineOf = (markdown: string): OutlineEntry[] => {
  const entries: OutlineEntry[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const opener = FENCE.exec(line)?.[1]
    if (opener) {
      if (!fence) fence = opener[0]!
      else if (opener[0] === fence) fence = null
      continue
    }
    if (fence) continue
    const match = HEADING.exec(line)
    if (!match) continue
    const text = plain(match[2]!)
    if (text) entries.push({ level: match[1]!.length as 1 | 2 | 3, text })
  }
  return entries
}

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownView } from './markdown'
import { ProjectKeysProvider } from './project-keys'

/**
 * Refs in prose. A write-up that says "supersedes S-4" or a log entry that
 * says "done in T-41" is only worth writing if the reader can follow it.
 */
const render = (body: string, keys: string[] = ['T'], prose?: 'writeup') =>
  renderToStaticMarkup(
    <ProjectKeysProvider keys={keys}>
      <MarkdownView prose={prose}>{body}</MarkdownView>
    </ProjectKeysProvider>,
  )

describe('refs in a body', () => {
  it('links a subject ref to its page', () => {
    const html = render('this supersedes S-4 entirely')
    expect(html).toContain('href="/subjects/4"')
  })

  it('links a todo ref to its task page', () => {
    expect(render('done in T-41')).toContain('href="/projects/T/tasks/41"')
  })

  it('leaves a ref inside an explicit link as the author wrote it', () => {
    const html = render('[the old one](https://example.com/S-4)')
    expect(html).not.toContain('href="/subjects/4"')
    expect(html).toContain('href="https://example.com/S-4"')
  })

  it('does not take a longer key for a subject', () => {
    expect(render('see HTTPS-4 and XS-9', [])).not.toContain('/subjects/')
  })

  it('sets a write-up in the reading voice', () => {
    expect(render('A paragraph.', ['T'], 'writeup')).toContain('class="text-fg writeup"')
  })
})

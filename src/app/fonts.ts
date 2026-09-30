import { JetBrains_Mono, Newsreader, Schibsted_Grotesk } from 'next/font/google'

/**
 * Croft's three faces, one job each, self-hosted by next/font and variable so
 * weights can sit between the named ones.
 *
 * - Schibsted Grotesk: the interface and its headings. A newspaper grotesk —
 *   sturdy at the 13-15px the controls are set in, with enough character at
 *   heading size that the lab does not read as a generic dashboard.
 * - Newsreader: the write-ups, conclusions and log. Drawn for long reading on
 *   screen, with an optical-size axis that tightens it for the small sizes.
 * - JetBrains Mono: refs (S-12, T-41) and code.
 */
export const sans = Schibsted_Grotesk({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-schibsted',
  display: 'swap',
})

export const serif = Newsreader({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-newsreader',
  style: ['normal', 'italic'],
  axes: ['opsz'],
  display: 'swap',
})

export const mono = JetBrains_Mono({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-jetbrains',
  display: 'swap',
})

export const fontVariables = `${sans.variable} ${serif.variable} ${mono.variable}`

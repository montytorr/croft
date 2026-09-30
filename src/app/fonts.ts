import { Inter_Tight } from 'next/font/google'

/**
 * The family's type, as Croft Cloud sets it: Inter Tight for headings, the
 * system sans for everything you read, the system mono for refs and code.
 *
 * The app used to carry a voice of its own — Instrument Serif for display
 * with italic accents, IBM Plex for text — and it read as a different product
 * from the site that sells it. The serif and the italics are exactly what the
 * family site dropped in MTC-2 for the same reason, and the login page brought
 * them back at 50px (CROFT-307).
 *
 * Only the display face is downloaded: the body and mono stacks are the
 * platform's own (SF Pro and SF Mono on a Mac), which are drawn for the 12-14px
 * this interface mostly is. Self-hosted by next/font, variable, so headings
 * can sit at a book weight between 400 and 500 as Cloud's do.
 */
export const display = Inter_Tight({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-inter-tight',
  display: 'swap',
})

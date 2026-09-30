import type { Metadata } from 'next'
import { ThemeProvider } from 'next-themes'
import { BrandProvider } from '@/components/brand'
import { paletteCss } from '@/lib/brand-colour'
import { getBranding } from '@/lib/branding'
import { display } from './fonts'
import './globals.css'

/**
 * Force request-time rendering for everything under the root layout.
 *
 * Without this, Next prerenders static pages (/login was one) at BUILD time
 * and bakes request state before the server can resolve a session.
 */
export const dynamic = 'force-dynamic'

const DESCRIPTION = 'Agent-first task tracker whose tasks double as shared memory.'

/**
 * Where relative metadata URLs — the opengraph-image among them — resolve.
 *
 * Read from CROFT_BASE_URL, the same variable the CLI and .env.example already
 * use for "the public URL of this instance", rather than hardcoding one host:
 * Croft is self-hosted, so the card has to point at whatever instance served
 * it. The localhost fallback only matters in development; without any
 * metadataBase Next emits a build warning and resolves the card against
 * localhost anyway.
 */
const baseUrl = process.env.CROFT_BASE_URL || 'http://localhost:3000'

/**
 * Named for the instance, so a personal Croft and a work one open side by side
 * are two different tabs. Each page gives only its own part of the title.
 *
 * The icons are routes rather than icon.svg and apple-icon.tsx files: those
 * are drawn at build time and could never carry an instance's colour.
 * The version on each URL changes with the branding, so a browser does not
 * keep yesterday's favicon.
 */
export const generateMetadata = async (): Promise<Metadata> => {
  const brand = await getBranding()
  const v = brand.version
  return {
    metadataBase: new URL(baseUrl),
    title: { default: brand.name, template: `%s · ${brand.name}` },
    description: DESCRIPTION,
    icons: {
      icon: [{ url: `/brand/icon?v=${v}`, type: 'image/svg+xml' }],
      apple: [{ url: `/brand/apple-icon?v=${v}` }],
    },
    openGraph: {
      type: 'website',
      siteName: brand.name,
      title: brand.name,
      description: DESCRIPTION,
      url: '/',
    },
    twitter: {
      card: 'summary_large_image',
      title: brand.name,
      description: DESCRIPTION,
    },
  }
}

const RootLayout = async ({ children }: { children: React.ReactNode }) => {
  const brand = await getBranding()
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={display.variable}
    >
      <body>
        {/* Every value is re-serialised from parsed numbers, never an admin's
            text, so this cannot carry anything but colours. */}
        {brand.palette ? <style dangerouslySetInnerHTML={{ __html: paletteCss(brand.palette) }} /> : null}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <BrandProvider brand={{ name: brand.name }}>{children}</BrandProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}

export default RootLayout

import { ImageResponse } from 'next/og'
import { getBranding } from '@/lib/branding'
import { STOCK_MARK } from '@/lib/brand-colour'
import { rigsDataUri } from '@/lib/brand-mark'

/**
 * The social card. Without one, every Croft link pasted into Slack or a pull
 * request renders as a bare URL.
 *
 * Paper, as the app is by default: the light tokens from globals.css (--bg,
 * --fg, --fg-muted, --border-strong), the mark on its peat tile, and a field
 * of rig strips running off the right-hand edge — the login page's field,
 * drawn once more at card size.
 *
 * No webfont is fetched: next/og would have to pull Schibsted Grotesk over the
 * network on every cold render, and a card that sometimes fails is worse than
 * a card set in the default face.
 */
export const alt = 'Croft — a lab notebook: subjects to explore, written up and walked through stages'
// Drawn per request: the name and the accent are the instance's.
export const dynamic = 'force-dynamic'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const GROUND = '#f6f2ea'
const FG = '#221c20'
const FG_MUTED = '#5c5358'
const FURROW = '#e2dace'

/** Five strips sweeping up and off the card, the nearest in the accent. */
const field = (accent: string) => {
  const strip = (x: number, w: number, fill: string) =>
    `<path d="M${x} 630 C${x + 10} 430 ${x + 250} 260 ${x + 230} 0 L${x + 230 + w * 0.55} 0 ` +
    `C${x + 270 + w * 0.55} 260 ${x + w + 30} 430 ${x + w} 630 Z" fill="${fill}"/>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 630" width="560" height="630">` +
    strip(20, 90, FURROW) +
    strip(130, 90, '#ddd3c5') +
    strip(240, 90, FURROW) +
    strip(350, 90, accent) +
    strip(460, 90, FURROW) +
    `</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

const OpengraphImage = async () => {
  const brand = await getBranding()
  const mark = brand.palette?.dark.accent ?? STOCK_MARK
  const accent = brand.palette?.light.accent ?? '#8e3f73'
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          background: GROUND,
          position: 'relative',
        }}
      >
        <img
          src={field(accent)}
          width={560}
          height={630}
          alt=""
          style={{ position: 'absolute', right: 0, top: 0 }}
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '0 96px',
            width: 760,
          }}
        >
          <img src={rigsDataUri(mark)} width={132} height={132} alt="" />
          <div
            style={{
              display: 'flex',
              marginTop: 48,
              fontSize: 104,
              lineHeight: 1,
              letterSpacing: -3,
              color: FG,
            }}
          >
            {brand.name}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 28,
              fontSize: 36,
              lineHeight: 1.35,
              letterSpacing: -0.4,
              color: FG_MUTED,
            }}
          >
            A lab notebook for subjects worth exploring — written up, worked, concluded.
          </div>
        </div>
      </div>
    ),
    size,
  )
}

export default OpengraphImage

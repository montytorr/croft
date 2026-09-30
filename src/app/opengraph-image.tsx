import { ImageResponse } from 'next/og'
import { getBranding } from '@/lib/branding'
import { STOCK_MARK } from '@/lib/brand-colour'

/**
 * The social card. Without one, every Croft link pasted into Slack or a pull
 * request renders as a bare URL.
 *
 * Colours are the app's own dark tokens read from globals.css (--bg, --fg,
 * --fg-muted, --border, --accent) rather than invented here, and the mark is
 * the same three solid stones as the favicon and home-screen icon — the card is the
 * third surface carrying one glyph, not a fourth piece of artwork.
 *
 * No webfont is fetched: next/og would have to pull Inter Tight over the network
 * on every cold render, and a card that sometimes fails is worse than a card
 * set in the default face.
 */
export const alt = 'Agent-first task tracker whose tasks double as shared memory'
// Drawn per request: the name and the accent are the instance's.
export const dynamic = 'force-dynamic'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const GROUND = '#08090a'
const FG = '#f7f8f8'
const FG_MUTED = '#9aa0a9'
const BORDER = '#1f2023'

// The 32-unit mark at 132px: scale 4.125, same stack, middle widest.
const Stone = ({ width, bottom, colour }: { width: number; bottom: number; colour: string }) => (
  <div
    style={{
      position: 'absolute',
      bottom,
      width,
      height: 23,
      borderRadius: 12,
      background: colour,
    }}
  />
)

const Mark = ({ colour }: { colour: string }) => (
  <div
    style={{
      display: 'flex',
      position: 'relative',
      width: 132,
      height: 132,
      borderRadius: 29,
      background: GROUND,
      border: `1px solid ${BORDER}`,
      alignItems: 'center',
      justifyContent: 'center',
    }}
  >
    <Stone width={58} bottom={24} colour={colour} />
    <Stone width={83} bottom={55} colour={colour} />
    <Stone width={50} bottom={86} colour={colour} />
  </div>
)

const OpengraphImage = async () => {
  const brand = await getBranding()
  const colour = brand.palette?.dark.accent ?? STOCK_MARK
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          background: GROUND,
          padding: '0 96px',
          position: 'relative',
        }}
      >
        <Mark colour={colour} />
        <div
          style={{
            display: 'flex',
            marginTop: 48,
            fontSize: 104,
            lineHeight: 1,
            letterSpacing: -3.6,
            color: FG,
          }}
        >
          {brand.name}
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 28,
            width: 840,
            fontSize: 36,
            lineHeight: 1.35,
            letterSpacing: -0.4,
            color: FG_MUTED,
          }}
        >
          Agent-first task tracker whose tasks double as shared memory.
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: 6,
            background: colour,
          }}
        />
      </div>
    ),
    size,
  )
}

export default OpengraphImage

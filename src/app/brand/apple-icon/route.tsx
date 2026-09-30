import { ImageResponse } from 'next/og'
import { getBranding } from '@/lib/branding'
import { STOCK_MARK } from '@/lib/brand-colour'

export const dynamic = 'force-dynamic'

/**
 * iOS ignores SVG favicons and wants a raster for the home screen, so the same
 * croft is drawn again at 180px rather than shipped as a binary — and drawn
 * per request, in the instance's accent.
 */
const GROUND = '#08090a'

// The 32-unit mark scaled by 180/32. Solid stones, middle widest.
const Stone = ({ width, bottom, colour }: { width: number; bottom: number; colour: string }) => (
  <div style={{ position: 'absolute', bottom, width, height: 31, borderRadius: 16, background: colour }} />
)

export const GET = async () => {
  const brand = await getBranding()
  const colour = brand.palette?.dark.accent ?? STOCK_MARK
  const image = new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          alignItems: 'center',
          justifyContent: 'center',
          background: GROUND,
        }}
      >
        <Stone width={79} bottom={32} colour={colour} />
        <Stone width={113} bottom={75} colour={colour} />
        <Stone width={68} bottom={117} colour={colour} />
      </div>
    ),
    { width: 180, height: 180 },
  )
  image.headers.set('cache-control', 'public, max-age=86400')
  return image
}

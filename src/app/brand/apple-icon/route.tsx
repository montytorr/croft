import { ImageResponse } from 'next/og'
import { getBranding } from '@/lib/branding'
import { STOCK_MARK } from '@/lib/brand-colour'
import { rigsDataUri } from '@/lib/brand-mark'

export const dynamic = 'force-dynamic'

/**
 * iOS ignores SVG favicons and wants a raster for the home screen, so the same
 * field is drawn again at 180px — per request, in the instance's accent, and
 * full-bleed, because iOS masks the corners itself.
 */
export const GET = async () => {
  const brand = await getBranding()
  const colour = brand.palette?.dark.accent ?? STOCK_MARK
  const image = new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={rigsDataUri(colour, { rounded: false })} width={180} height={180} alt="" />
      </div>
    ),
    { width: 180, height: 180 },
  )
  image.headers.set('cache-control', 'public, max-age=86400')
  return image
}

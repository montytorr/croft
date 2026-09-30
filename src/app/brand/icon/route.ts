import { getBranding } from '@/lib/branding'
import { STOCK_MARK } from '@/lib/brand-colour'
import { rigsSvg } from '@/lib/brand-mark'

export const dynamic = 'force-dynamic'

/**
 * The favicon: the three rig strips in the instance's accent, so two Crofts
 * open side by side are two different tabs. The dark variant of the accent,
 * because the strips always sit on the peat tile.
 */
export const GET = async () => {
  const brand = await getBranding()
  return new Response(rigsSvg(brand.palette?.dark.accent ?? STOCK_MARK), {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
  })
}

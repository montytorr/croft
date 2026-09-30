import { getBranding } from '@/lib/branding'
import { STOCK_MARK } from '@/lib/brand-colour'
import { stonesSvg } from '@/lib/brand-mark'

export const dynamic = 'force-dynamic'

/**
 * The favicon: the three stones in the instance's accent, so two Crofts open
 * side by side are two different tabs. The dark variant, because the stones
 * always sit on the dark tile.
 */
export const GET = async () => {
  const brand = await getBranding()
  return new Response(stonesSvg(brand.palette?.dark.accent ?? STOCK_MARK), {
    headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
  })
}

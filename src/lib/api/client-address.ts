/**
 * The address a request came from, as far as a trusted proxy can say.
 *
 * `X-Forwarded-For` is a list every hop appends to, and the client can start
 * it with anything. So the entry to believe is the one the nearest trusted
 * proxy added: the last one, or further left when there are several trusted
 * hops. Reading the first entry — which is what this used to do — lets any
 * client pick its own address, and with it its own rate-limit bucket.
 *
 * CROFT_TRUSTED_PROXY_HOPS is how many proxies in front of the app append to
 * the header (default 1: Traefik, an ALB, App Runner's front end). With no
 * header at all there is no proxy, and no address to go on.
 */
export const clientAddress = (headers: Headers): string => {
  const hops = Math.max(1, Number(process.env.CROFT_TRUSTED_PROXY_HOPS) || 1)
  const chain = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (chain.length === 0) return 'unknown'
  return chain[Math.max(0, chain.length - hops)] ?? 'unknown'
}

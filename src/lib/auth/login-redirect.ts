/**
 * The page a request was for, set by the middleware on every request it lets
 * through. A layout cannot read its own URL, and without this a stale session
 * — cookie present, so the middleware passed it — was sent to a bare /login
 * and landed on / after signing in instead of where it was going (a
 * `/connect/<code>` approval, above all).
 */
export const REQUESTED_PATH_HEADER = 'x-croft-path'

const SAME_SITE = 'http://croft.invalid'

/**
 * A same-site path, or `/`. Parsed the way the browser will parse it, not
 * matched by prefix: `//host`, `/\host` and `/<tab>/host` (the URL parser drops
 * tabs and newlines) all start with a slash and all leave the site.
 */
export const safeRedirect = (value: string | null | undefined): string => {
  if (!value || !value.startsWith('/')) return '/'
  try {
    const url = new URL(value, SAME_SITE)
    return url.origin === SAME_SITE ? `${url.pathname}${url.search}${url.hash}` : '/'
  } catch {
    return '/'
  }
}

export const loginUrlFor = (path: string | null | undefined): string => {
  const target = safeRedirect(path)
  return target === '/' ? '/login' : `/login?redirect=${encodeURIComponent(target)}`
}

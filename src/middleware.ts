import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE } from '@/lib/auth/cookie'
import { REQUESTED_PATH_HEADER } from '@/lib/auth/login-redirect'

/**
 * Server-side route protection.
 *
 * This exists because the alternative — a client-side `useEffect` that checks
 * the session and redirects — is not access control: by the time it runs, the
 * RSC payload has already been served. a2a-comms ships exactly that pattern
 * and has no middleware at all; Croft does not repeat it.
 *
 * /api/v1/* is excluded: those routes authenticate bearer API keys themselves,
 * and must stay reachable without a browser session.
 */
export const middleware = async (req: NextRequest) => {
  if (req.nextUrl.pathname.startsWith('/api/auth/') || req.nextUrl.pathname === '/api/files') {
    return NextResponse.next({ request: req })
  }
  // Middleware runs in an edge-like runtime and performs the cheap redirect.
  // The app layout and API handlers resolve the opaque token against Postgres
  // before they read any data.
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value)
  // /reset/<token> is for someone who cannot sign in: it must open signed out,
  // and must never be bounced to /login with the token copied into ?redirect=.
  const isPublicRoute = req.nextUrl.pathname.startsWith('/login') || req.nextUrl.pathname.startsWith('/reset/')

  if (!hasSession && !isPublicRoute) {
    const url = req.nextUrl.clone()
    // Carry the whole destination, query included, and clear the rest: keeping
    // the original params meant /search?q=x came back as a bare /search, and
    // leaked them onto the login URL besides.
    const target = `${req.nextUrl.pathname}${req.nextUrl.search}`
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('redirect', target)
    return NextResponse.redirect(url)
  }

  // No "has a cookie, so leave /login" here: a cookie is not a session. After a
  // password change, an expiry or a revoked session the browser still sends
  // one, the app layout finds it invalid and sends it to /login, and this used
  // to send it straight back to / — a redirect loop with no way out but
  // clearing cookies. The login page decides, against Postgres.

  // So a layout that finds the session invalid can still send the visitor
  // back here after signing in. Always overwritten: never the client's own.
  const forwarded = new Headers(req.headers)
  forwarded.set(REQUESTED_PATH_HEADER, `${req.nextUrl.pathname}${req.nextUrl.search}`)
  return NextResponse.next({ request: { headers: forwarded } })
}

export const config = {
  matcher: [
    /*
     * Everything except: the agent API (bearer-authenticated), Next internals,
     * the health probe, and static assets.
     *
     * `brand/*` (the icons) and `opengraph-image` are route handlers, not
     * files, so the extension rule below does not cover them — an icon behind
     * a login redirect is an icon the browser never gets.
     */
    '/((?!api/v1|api/auth|api/files|_next/static|_next/image|favicon.ico|brand/|opengraph-image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}

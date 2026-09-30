import { describe, expect, it } from 'vitest'
import { isTrustedMutationOrigin } from './handler'

const request = (method: string, headers?: HeadersInit) =>
  new Request('https://croft.example.test/api/v1/users', { method, headers })

describe('browser mutation origin', () => {
  it('allows safe reads without an origin', () => {
    expect(isTrustedMutationOrigin(request('GET'))).toBe(true)
  })

  it('allows bearer mutations without browser origin metadata', () => {
    expect(isTrustedMutationOrigin(request('POST', { authorization: 'Bearer sk_live_test' }))).toBe(true)
  })

  it('allows same-origin browser mutations', () => {
    expect(isTrustedMutationOrigin(request('POST', { origin: 'https://croft.example.test' }))).toBe(true)
  })

  it('rejects missing and sibling origins for cookie-authenticated mutations', () => {
    expect(isTrustedMutationOrigin(request('POST'))).toBe(false)
    expect(
      isTrustedMutationOrigin(request('POST', { origin: 'https://evil.example.test' })),
    ).toBe(false)
  })
})

/**
 * Behind a proxy that terminates TLS — the deployment the README documents —
 * the application receives a plaintext request while the browser announces an
 * https origin. Comparing against the request's own URL can then never match,
 * and every browser write is refused.
 */
describe('browser mutation origin, behind a reverse proxy', () => {
  // What the container actually receives once Traefik has terminated TLS.
  const behindProxy = (headers: HeadersInit) =>
    new Request('http://croft.example.test/api/v1/users', { method: 'POST', headers })

  it('accepts the browser origin when the proxy says the hop was https', () => {
    expect(
      isTrustedMutationOrigin(
        behindProxy({ origin: 'https://croft.example.test', 'x-forwarded-proto': 'https' }),
      ),
    ).toBe(true)
  })

  it('accepts a host rewritten by the proxy', () => {
    expect(
      isTrustedMutationOrigin(
        new Request('http://croft-interne:3000/api/v1/users', {
          method: 'POST',
          headers: {
            origin: 'https://croft.example.test',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'croft.example.test',
          },
        }),
      ),
    ).toBe(true)
  })

  it('still refuses a foreign origin, proxy headers or not', () => {
    // The point not to break: honouring the proxy headers must not turn the
    // check into a formality.
    expect(
      isTrustedMutationOrigin(
        behindProxy({ origin: 'https://evil.example.test', 'x-forwarded-proto': 'https' }),
      ),
    ).toBe(false)
  })

  it('takes only the first hop when a chain of proxies appends its own', () => {
    // X-Forwarded-* is a comma-separated list; the first entry is the client's.
    expect(
      isTrustedMutationOrigin(
        behindProxy({ origin: 'https://croft.example.test', 'x-forwarded-proto': 'https, http' }),
      ),
    ).toBe(true)
  })

  it('compares normal forms, so an explicit default port still matches', () => {
    // nginx hands back the Host verbatim. A browser never puts :443 in an
    // Origin, so comparing the strings as written refuses a correct install.
    expect(
      isTrustedMutationOrigin(
        behindProxy({
          origin: 'https://croft.example.test',
          'x-forwarded-proto': 'HTTPS',
          'x-forwarded-host': 'Croft.Example.Test:443',
        }),
      ),
    ).toBe(true)
  })

  it('falls back to the request when a forwarded header cannot be parsed', () => {
    // Refuses rather than admits, and never throws: an unparseable header must
    // not turn a 403 into a 500.
    expect(
      isTrustedMutationOrigin(
        behindProxy({
          origin: 'https://croft.example.test',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'not a host',
        }),
      ),
    ).toBe(false)
  })
})

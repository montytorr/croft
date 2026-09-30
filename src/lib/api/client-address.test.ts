import { afterEach, describe, expect, it } from 'vitest'
import { clientAddress } from './client-address'

const headers = (xff?: string) => new Headers(xff === undefined ? {} : { 'x-forwarded-for': xff })

afterEach(() => { delete process.env.CROFT_TRUSTED_PROXY_HOPS })

describe('the address a login is counted against', () => {
  it('is the entry the nearest proxy added, not the one the client wrote', () => {
    // A client behind an ALB or App Runner sends its own X-Forwarded-For and
    // the proxy appends the real address after it.
    expect(clientAddress(headers('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9')
  })

  it('counts back further when there are more trusted proxies', () => {
    process.env.CROFT_TRUSTED_PROXY_HOPS = '2'
    expect(clientAddress(headers('6.6.6.6, 203.0.113.9, 10.0.0.2'))).toBe('203.0.113.9')
  })

  it('takes the only entry when there is one', () => {
    expect(clientAddress(headers('203.0.113.9'))).toBe('203.0.113.9')
  })

  it('has nothing to go on without a proxy', () => {
    expect(clientAddress(headers())).toBe('unknown')
    expect(clientAddress(headers(' , '))).toBe('unknown')
  })
})

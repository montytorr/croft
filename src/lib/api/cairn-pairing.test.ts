import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from './auth'

const mocks = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('./cairn-link', () => ({ saveCairnConnection: mocks.save }))

import { cairnPairingUrl, pollCairnPairing, startCairnPairing } from './cairn-pairing'
import { openSecret, sealSecret } from '@/lib/secret-box'

const actor: Actor = { userId: 'admin-1', actorType: 'human', actorId: 'Admin', userDisplayName: 'Admin', role: 'admin', rateKey: 'admin', sessionId: null }
const deviceCode = 'd'.repeat(43)
const key = `sk_live_${'k'.repeat(43)}`
const started = { deviceCode, verificationUrl: 'https://cairn.example/connect/ABCD-EFGH', expiresIn: 600, interval: 3 }
const fetcher = (data: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true, data })))

beforeEach(() => {
  vi.restoreAllMocks()
  mocks.save.mockReset().mockResolvedValue({ url: 'https://cairn.example', key_set: true, last_synced_at: null })
  process.env.CROFT_SECRET_KEY = 'a'.repeat(64)
})

describe('Cairn browser pairing', () => {
  it('keeps the device code encrypted and saves the approved key without returning it to the browser', async () => {
    const begin = fetcher(started)
    const pending = await startCairnPairing(actor, 'https://cairn.example/', begin)
    expect(pending.verificationUrl).toBe(started.verificationUrl)
    expect(JSON.stringify(pending)).not.toContain(deviceCode)
    expect(begin).toHaveBeenCalledWith('https://cairn.example/api/v1/connect', expect.objectContaining({
      redirect: 'error', body: JSON.stringify({ host: 'croft-server', runtimes: ['croft'] }),
    }))
    expect(mocks.save).not.toHaveBeenCalled()
    const poll = fetcher({ status: 'approved', keys: [{ agentName: 'croft', key }] })
    const result = await pollCairnPairing(actor, pending.token, poll)
    expect(poll).toHaveBeenCalledWith('https://cairn.example/api/v1/connect/poll', expect.objectContaining({
      redirect: 'error', body: JSON.stringify({ deviceCode }),
    }))
    expect(mocks.save).toHaveBeenCalledWith(actor, { url: 'https://cairn.example', apiKey: key })
    expect(result).toEqual({ status: 'approved', connection: { url: 'https://cairn.example', key_set: true, last_synced_at: null } })
    expect(JSON.stringify(result)).not.toContain(key)
  })

  it.each([
    { ...actor, actorType: 'agent' as const, agentName: 'codex' },
    { ...actor, role: 'member' as const },
  ])('requires a human administrator before any remote request', async (caller) => {
    const remote = fetcher(started)
    await expect(startCairnPairing(caller, 'https://cairn.example', remote)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(pollCairnPairing(caller, 'invalid', remote)).rejects.toMatchObject({ code: 'forbidden' })
    expect(remote).not.toHaveBeenCalled()
  })

  it('binds a pairing to the administrator who started it', async () => {
    const pending = await startCairnPairing(actor, 'https://cairn.example', fetcher(started))
    const remote = fetcher({ status: 'approved', keys: [{ agentName: 'croft', key }] })
    await expect(pollCairnPairing({ ...actor, userId: 'admin-2' }, pending.token, remote)).rejects.toMatchObject({ code: 'forbidden' })
    expect(remote).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('refuses altered tokens, and expired requests never reach Cairn', async () => {
    const pending = await startCairnPairing(actor, 'https://cairn.example', fetcher(started))
    const remote = fetcher({ status: 'pending' })
    await expect(pollCairnPairing(actor, pending.token.slice(0, -8), remote)).rejects.toMatchObject({ code: 'conflict' })
    const decoded = JSON.parse(openSecret(pending.token, 'cairn_connection.pairing'))
    const expired = sealSecret(JSON.stringify({ ...decoded, expiresAt: 1 }), 'cairn_connection.pairing')
    expect(await pollCairnPairing(actor, expired, remote)).toEqual({ status: 'expired' })
    expect(remote).not.toHaveBeenCalled()
  })

  it.each(['pending', 'denied', 'expired'])('keeps the current connection when Cairn says %s', async (status) => {
    const pending = await startCairnPairing(actor, 'https://cairn.example', fetcher(started))
    expect(await pollCairnPairing(actor, pending.token, fetcher({ status }))).toEqual({ status })
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('does not open a verification link on a different origin', async () => {
    await expect(startCairnPairing(actor, 'https://cairn.example', fetcher({ ...started, verificationUrl: 'https://other.example/connect/ABCD' })))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('does not save an unexpected runtime or malformed key', async () => {
    for (const keys of [[{ agentName: 'codex', key }], [{ agentName: 'croft', key: 'bad-key' }]]) {
      const pending = await startCairnPairing(actor, 'https://cairn.example', fetcher(started))
      await expect(pollCairnPairing(actor, pending.token, fetcher({ status: 'approved', keys }))).rejects.toMatchObject({ code: 'conflict' })
    }
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('reports unavailable pairing without reflecting a remote response containing secrets', async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: false, error: key }), { status: 404 }))
    await expect(startCairnPairing(actor, 'https://cairn.example', remote)).rejects.toThrow('does not support browser pairing')
  })
})

describe('Cairn pairing URLs', () => {
  it.each(['http://cairn.example', 'file:///etc/passwd', 'https://user:pass@cairn.example', 'https://cairn.example/?token=x', 'https://cairn.example/#x'])('refuses %s', (url) => {
    expect(() => cairnPairingUrl(url)).toThrow()
  })
  it('allows HTTPS and local development', () => {
    expect(cairnPairingUrl(' https://cairn.example/ ')).toBe('https://cairn.example')
    expect(cairnPairingUrl('http://127.0.0.1:3218')).toBe('http://127.0.0.1:3218')
  })
})

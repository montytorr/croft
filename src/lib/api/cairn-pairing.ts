import { z } from 'zod'
import { openSecret, sealSecret } from '@/lib/secret-box'
import { saveCairnConnection } from './cairn-link'
import { canAdministerUsers } from './actor'
import type { Actor } from './auth'
import { looksLikeApiKey } from './keys'

const PURPOSE = 'cairn_connection.pairing'
const LIFETIME_MS = 10 * 60_000
const tokenSchema = z.object({
  url: z.string().url(), deviceCode: z.string().min(32).max(500),
  userId: z.string(), expiresAt: z.number(),
})

export class CairnPairingError extends Error {
  constructor(readonly code: 'forbidden' | 'validation_failed' | 'conflict', message: string) {
    super(message)
  }
}

const requireAdmin = (actor: Actor) => {
  if (!canAdministerUsers(actor)) {
    throw new CairnPairingError('forbidden', 'Only a signed-in administrator can connect Cairn.')
  }
}

/** Pairing sends a redeemable code, so require TLS except on local development. */
export const cairnPairingUrl = (raw: string): string => {
  let url: URL
  try { url = new URL(raw.trim()) } catch {
    throw new CairnPairingError('validation_failed', 'Enter the Cairn instance URL.')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new CairnPairingError('validation_failed', 'Use a bare HTTPS Cairn URL (HTTP is allowed on localhost).')
  }
  return url.href.replace(/\/+$/, '')
}

const cairnRequest = async (base: string, path: string, body: object, fetcher: typeof fetch): Promise<unknown> => {
  let response: Response
  try {
    response = await fetcher(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store',
    })
  } catch {
    throw new CairnPairingError('conflict', 'Could not reach Cairn. Check its URL and try again.')
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.success || !payload.data) {
    throw new CairnPairingError('conflict', response.status === 404
      ? 'This Cairn instance does not support browser pairing. Enter an API key instead.'
      : 'Cairn could not complete pairing. Try again in a moment.')
  }
  return payload.data
}

const startSchema = z.object({
  deviceCode: z.string().min(32).max(500), verificationUrl: z.string().url(),
  expiresIn: z.number().positive().max(600), interval: z.number().min(1).max(60),
})

/** The browser gets a sealed, short-lived handle; the redeemable code stays encrypted. */
export const startCairnPairing = async (actor: Actor, rawUrl: string, fetcher: typeof fetch = fetch) => {
  requireAdmin(actor)
  const url = cairnPairingUrl(rawUrl)
  const reply = startSchema.safeParse(await cairnRequest(url, '/api/v1/connect', {
    host: 'croft-server', runtimes: ['croft'],
  }, fetcher))
  if (!reply.success || new URL(reply.data.verificationUrl).origin !== new URL(url).origin ||
      new URL(reply.data.verificationUrl).username || new URL(reply.data.verificationUrl).password) {
    throw new CairnPairingError('conflict', 'Cairn returned an invalid pairing response.')
  }
  const expiresAt = Date.now() + Math.min(LIFETIME_MS, reply.data.expiresIn * 1000)
  return {
    token: sealSecret(JSON.stringify({ url, deviceCode: reply.data.deviceCode, userId: actor.userId, expiresAt }), PURPOSE),
    verificationUrl: reply.data.verificationUrl, interval: reply.data.interval, expiresAt,
  }
}

const pollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), slowDown: z.boolean().optional() }),
  z.object({ status: z.literal('denied') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('approved'), keys: z.array(z.object({ agentName: z.string(), key: z.string() })) }),
])

/** A signed-in admin who started this pairing saves only the explicitly approved Croft key. */
export const pollCairnPairing = async (actor: Actor, sealedToken: string, fetcher: typeof fetch = fetch) => {
  requireAdmin(actor)
  let pending: z.infer<typeof tokenSchema>
  try { pending = tokenSchema.parse(JSON.parse(openSecret(sealedToken, PURPOSE))) } catch {
    throw new CairnPairingError('conflict', 'This pairing request is no longer valid. Start again.')
  }
  if (pending.userId !== actor.userId) {
    throw new CairnPairingError('forbidden', 'This pairing request belongs to another administrator.')
  }
  if (pending.expiresAt <= Date.now()) return { status: 'expired' as const }
  const reply = pollSchema.safeParse(await cairnRequest(pending.url, '/api/v1/connect/poll', {
    deviceCode: pending.deviceCode,
  }, fetcher))
  if (!reply.success) throw new CairnPairingError('conflict', 'Cairn returned an invalid pairing response.')
  if (reply.data.status !== 'approved') return reply.data
  const key = reply.data.keys.find((k) => k.agentName === 'croft')?.key
  if (!key || !looksLikeApiKey(key)) throw new CairnPairingError('conflict', 'No Croft key was approved. Start pairing again.')
  const connection = await saveCairnConnection(actor, { url: pending.url, apiKey: key })
  return { status: 'approved' as const, connection }
}

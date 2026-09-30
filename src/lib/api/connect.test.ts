import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  createUserKey: vi.fn(),
}))

vi.mock('@/lib/db/client', () => ({
  pool: () => ({ query: mocks.query }),
  transaction: mocks.transaction,
}))

vi.mock('./users', () => ({
  createUserKey: mocks.createUserKey,
  UserAdminError: class UserAdminError extends Error {},
}))

import {
  approveConnectRequest,
  createConnectRequest,
  denyConnectRequest,
  findConnectRequestByUserCode,
  normalizeUserCode,
  pollConnectRequest,
  POLL_INTERVAL_SECONDS,
  RUNTIME_PATTERN,
} from './connect'

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const inFuture = () => new Date(Date.now() + 5 * 60_000).toISOString()
const inPast = () => new Date(Date.now() - 5_000).toISOString()

beforeEach(() => {
  mocks.query.mockReset()
  mocks.transaction.mockReset()
  mocks.createUserKey.mockReset()
  mocks.transaction.mockImplementation(async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) =>
    run({ query: mocks.query }),
  )
})

describe('normalizeUserCode', () => {
  it('uppercases and reformats a code typed without the dash', () => {
    expect(normalizeUserCode('bcdf2345')).toBe('BCDF-2345')
  })

  it('strips stray separators and whitespace', () => {
    expect(normalizeUserCode(' bcdf - 2345 ')).toBe('BCDF-2345')
  })

  it('leaves a malformed code unformatted, so it matches nothing', () => {
    expect(normalizeUserCode('nope')).toBe('NOPE')
  })
})

describe('RUNTIME_PATTERN', () => {
  it('accepts a runtime name', () => {
    expect(RUNTIME_PATTERN.test('claude-code')).toBe(true)
  })

  it('rejects a name starting with a digit or carrying uppercase', () => {
    expect(RUNTIME_PATTERN.test('1codex')).toBe(false)
    expect(RUNTIME_PATTERN.test('Codex')).toBe(false)
  })
})

describe('createConnectRequest', () => {
  it('creates a request and shapes the response', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }) // opportunistic cleanup delete
      .mockResolvedValueOnce({ rows: [] }) // insert

    const result = await createConnectRequest({
      host: 'macbook',
      runtimes: ['claude-code'],
      clientAddress: '203.0.113.4',
      baseUrl: 'https://croft.example.test',
    })

    expect(result.expiresIn).toBe(600)
    expect(result.interval).toBe(3)
    expect(result.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(result.verificationUrl).toBe(`https://croft.example.test/connect/${result.userCode}`)
    // Only its hash is ever persisted.
    const insertCall = mocks.query.mock.calls[1]!
    expect(String(insertCall[0])).toContain('insert into connect_requests')
    expect(insertCall[1]).toContain(sha256Hex(result.deviceCode))
    expect(insertCall[1]).not.toContain(result.deviceCode)
  })

  it('retries with fresh randomness on a user_code collision', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }) // cleanup
      .mockRejectedValueOnce({ code: '23505' }) // first insert collides
      .mockResolvedValueOnce({ rows: [] }) // second insert succeeds

    const result = await createConnectRequest({
      host: 'macbook',
      runtimes: ['claude-code'],
      clientAddress: '203.0.113.4',
      baseUrl: 'https://croft.example.test',
    })

    expect(result.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(mocks.query).toHaveBeenCalledTimes(3)
  })
})

describe('findConnectRequestByUserCode', () => {
  it('never queries the database for a code that cannot possibly match', async () => {
    const result = await findConnectRequestByUserCode('nope')
    expect(result).toBeNull()
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('normalizes before looking up', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'req-1' }] })
    await findConnectRequestByUserCode('bcdf2345')
    expect(mocks.query.mock.calls[0]![1]).toEqual(['BCDF-2345'])
  })
})

describe('approveConnectRequest', () => {
  const pendingRow = {
    id: 'req-1',
    device_code_hash: 'h',
    user_code: 'BCDF-2345',
    host: 'macbook',
    runtimes: ['claude-code', 'codex'],
    cli_version: null,
    client_address: null,
    status: 'pending',
    approved_by: null,
    approved_runtimes: null,
    expires_at: inFuture(),
    created_at: new Date().toISOString(),
  }

  it('approves a subset of the requested runtimes', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [pendingRow] }) // find
      .mockResolvedValueOnce({ rows: [{ id: 'req-1' }] }) // conditional update

    await approveConnectRequest('BCDF-2345', { runtimes: ['claude-code'], approvedBy: 'user-1', approverRole: 'member' })

    const update = mocks.query.mock.calls[1]!
    expect(String(update[0])).toContain(`status = 'approved'`)
    expect(String(update[0])).toContain(`status = 'pending'`)
    expect(update[1]).toEqual(['req-1', 'user-1', ['claude-code']])
  })

  it('refuses a maintenance key to a member — it acts on everyone\'s work', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...pendingRow, runtimes: ['claude-code', 'maintenance'] }] })

    await expect(
      approveConnectRequest('BCDF-2345', { runtimes: ['maintenance'], approvedBy: 'user-1', approverRole: 'member' }),
    ).rejects.toMatchObject({ code: 'forbidden_runtime' })
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })

  it('lets an administrator approve a maintenance key', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ ...pendingRow, runtimes: ['maintenance'] }] })
      .mockResolvedValueOnce({ rows: [{ id: 'req-1' }] })

    await approveConnectRequest('BCDF-2345', { runtimes: ['maintenance'], approvedBy: 'user-1', approverRole: 'admin' })
    expect(mocks.query.mock.calls[1]![1]).toEqual(['req-1', 'user-1', ['maintenance']])
  })

  it('refuses a runtime that was not requested, without writing anything', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [pendingRow] })

    await expect(
      approveConnectRequest('BCDF-2345', { runtimes: ['openclaw'], approvedBy: 'user-1', approverRole: 'member' }),
    ).rejects.toMatchObject({ code: 'invalid_runtimes' })
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty selection', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [pendingRow] })
    await expect(
      approveConnectRequest('BCDF-2345', { runtimes: [], approvedBy: 'user-1', approverRole: 'member' }),
    ).rejects.toMatchObject({ code: 'invalid_runtimes' })
  })

  it('reports not_found for an unknown code', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    await expect(
      approveConnectRequest('BCDF-2345', { runtimes: ['claude-code'], approvedBy: 'user-1', approverRole: 'member' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reports not_pending when the conditional update loses the race', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [pendingRow] })
      .mockResolvedValueOnce({ rows: [] }) // someone else denied/expired it first
    await expect(
      approveConnectRequest('BCDF-2345', { runtimes: ['claude-code'], approvedBy: 'user-1', approverRole: 'member' }),
    ).rejects.toMatchObject({ code: 'not_pending' })
  })
})

describe('denyConnectRequest', () => {
  const pendingRow = {
    id: 'req-1',
    status: 'pending',
    runtimes: ['claude-code'],
    expires_at: inFuture(),
  }

  it('denies a pending request', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [pendingRow] })
      .mockResolvedValueOnce({ rows: [{ id: 'req-1' }] })
    await denyConnectRequest('BCDF-2345')
    expect(String(mocks.query.mock.calls[1]![0])).toContain(`status = 'denied'`)
  })

  it('reports not_found for an unknown code', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    await expect(denyConnectRequest('BCDF-2345')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reports not_pending for one already decided', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [pendingRow] })
      .mockResolvedValueOnce({ rows: [] })
    await expect(denyConnectRequest('BCDF-2345')).rejects.toMatchObject({ code: 'not_pending' })
  })
})

describe('pollConnectRequest', () => {
  it('reports expired for an unknown device code, the same as any other unredeemable one', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] })
    expect(await pollConnectRequest('nope')).toEqual({ status: 'expired' })
  })

  it('reports pending while nobody has decided yet', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ device_code_hash: sha256Hex('dc-1'), status: 'pending', expires_at: inFuture() }],
    })
    expect(await pollConnectRequest('dc-1')).toEqual({ status: 'pending' })
  })

  it('reports denied once denied, and stays denied', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ device_code_hash: sha256Hex('dc-2'), status: 'denied', expires_at: inFuture() }],
    })
    expect(await pollConnectRequest('dc-2')).toEqual({ status: 'denied' })
  })

  it('reports expired for a request already consumed — no second copy of the keys', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ device_code_hash: sha256Hex('dc-3'), status: 'consumed', expires_at: inFuture() }],
    })
    expect(await pollConnectRequest('dc-3')).toEqual({ status: 'expired' })
  })

  it('flips a timed-out pending request to expired and reports it', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ device_code_hash: sha256Hex('dc-4'), status: 'pending', expires_at: inPast() }] })
      .mockResolvedValueOnce({ rows: [{ id: 'req-4' }] }) // the expiring update
    expect(await pollConnectRequest('dc-4')).toEqual({ status: 'expired' })
    expect(String(mocks.query.mock.calls[1]![0])).toContain(`status = 'expired'`)
  })

  it('mints one key per approved runtime and consumes the request', async () => {
    mocks.createUserKey
      .mockResolvedValueOnce({ key: 'sk_live_claude' })
      .mockResolvedValueOnce({ key: 'sk_live_codex' })
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'req-5', device_code_hash: sha256Hex('dc-5'), status: 'approved',
          approved_by: 'user-1', approved_runtimes: ['claude-code', 'codex'], host: 'macbook',
          expires_at: inFuture(),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'cal@example.test', name: 'Cal' }] }) // user lookup
      .mockResolvedValueOnce({ rows: [{ approved_runtimes: ['claude-code', 'codex'], host: 'macbook' }] }) // consume

    const result = await pollConnectRequest('dc-5')

    expect(result).toEqual({
      status: 'approved',
      user: { id: 'user-1', email: 'cal@example.test', name: 'Cal' },
      keys: [
        { agentName: 'claude-code', key: 'sk_live_claude' },
        { agentName: 'codex', key: 'sk_live_codex' },
      ],
    })
    expect(mocks.createUserKey).toHaveBeenNthCalledWith(
      1, 'user-1', { agentName: 'claude-code', name: 'claude-code on macbook' }, { query: mocks.query },
    )
  })

  it('expires rather than mints when the approver is no longer a valid keyholder', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'req-6', device_code_hash: sha256Hex('dc-6'), status: 'approved',
          approved_by: 'user-1', approved_runtimes: ['claude-code'], host: 'macbook',
          expires_at: inFuture(),
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // user lookup: gone or deactivated
      .mockResolvedValueOnce({ rows: [{ id: 'req-6' }] }) // marks it expired

    expect(await pollConnectRequest('dc-6')).toEqual({ status: 'expired' })
    expect(mocks.createUserKey).not.toHaveBeenCalled()
    expect(String(mocks.query.mock.calls[2]![0])).toContain(`status = 'expired'`)
  })

  it('expires rather than double-mint when a concurrent poll already consumed it', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'req-7', device_code_hash: sha256Hex('dc-7'), status: 'approved',
          approved_by: 'user-1', approved_runtimes: ['claude-code'], host: 'macbook',
          expires_at: inFuture(),
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'cal@example.test', name: 'Cal' }] })
      .mockResolvedValueOnce({ rows: [] }) // lost the compare-and-swap

    expect(await pollConnectRequest('dc-7')).toEqual({ status: 'expired' })
    expect(mocks.createUserKey).not.toHaveBeenCalled()
  })

  it('flags a poll faster than the interval, without changing the answer', async () => {
    const row = { device_code_hash: sha256Hex('dc-8'), status: 'pending', expires_at: inFuture() }
    mocks.query.mockResolvedValue({ rows: [row] })

    expect(await pollConnectRequest('dc-8')).toEqual({ status: 'pending' })
    expect(await pollConnectRequest('dc-8')).toEqual({ status: 'pending', slowDown: true })
  })
})

// Documents the constant this file's design comments and the contract agree on.
it('polls no faster than every 3 seconds before slowDown kicks in', () => {
  expect(POLL_INTERVAL_SECONDS).toBe(3)
})

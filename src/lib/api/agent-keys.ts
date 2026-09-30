import { pool } from '@/lib/db/client'

/**
 * An agent key as any API response shows it — the admin's view of someone's
 * keys and a person's view of their own are the same resource, so they are
 * the same shape (CROFT-317). Never the hash, never the secret: the plaintext
 * is shown once, when the key is created, and nothing here could reproduce it.
 */
export type AgentKey = {
  id: string
  agentName: string
  name: string
  keyPrefix: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  /**
   * Whether the key is actually refused — `revokedAt` alone is not enough.
   *
   * `authenticate()` also refuses a key whose `auth_epoch` has fallen behind
   * its user's (a bump kills every key issued before it in one write, without
   * touching each row's `revoked_at`). Today the one place that bumps a
   * user's epoch — deactivating them — revokes every key in the same
   * transaction, so the two never disagree in practice. This checks the
   * epoch anyway rather than trusting that invariant to hold forever: a key
   * the server would refuse must never read back as active here.
   */
  revoked: boolean
}

export const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString()

/** Every key a user holds, revoked ones included, oldest first. */
export const listAgentKeys = async (userId: string): Promise<AgentKey[]> => {
  const result = await pool().query<{
    id: string
    agent_name: string
    name: string
    key_prefix: string
    created_at: Date
    last_used_at: Date | null
    revoked_at: Date | null
    key_auth_epoch: string
    user_auth_epoch: string
  }>(
    `select k.id, k.agent_name, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at,
            k.auth_epoch as key_auth_epoch, u.auth_epoch as user_auth_epoch
       from api_keys k
       join app_users u on u.id = k.user_id
      where k.user_id = $1
      order by k.created_at, k.id`,
    [userId],
  )
  return result.rows.map((row) => ({
    id: row.id,
    agentName: row.agent_name,
    name: row.name,
    keyPrefix: row.key_prefix,
    createdAt: iso(row.created_at)!,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    revoked: row.revoked_at !== null || row.key_auth_epoch !== row.user_auth_epoch,
  }))
}

import { listAgentKeys, type AgentKey } from './agent-keys'
import { revokeUserKey } from './users'

/** One of the signed-in person's own keys (CROFT-315): the same shape an administrator sees. */
export type OwnKey = AgentKey

export const listOwnKeys = (userId: string): Promise<OwnKey[]> => listAgentKeys(userId)

/**
 * The administrator's revocation, with the caller as the owner — so a key
 * that is someone else's is `not_found`, exactly like one that never existed.
 */
export const revokeOwnKey = async (
  userId: string,
  keyId: string,
): Promise<{ id: string; agentName: string; revokedAt: string }> => revokeUserKey(userId, keyId)

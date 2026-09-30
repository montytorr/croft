/**
 * Pairing names every key `<runtime> on <host>` (CROFT-314), and the host is
 * what someone retiring a laptop is looking for. Only a name that is exactly
 * that shape — the runtime matching the key's own agent name, the host as
 * `/api/v1/connect` accepts one — counts; anything an administrator typed by
 * hand falls under "Other" rather than being guessed at.
 */
export const OTHER_HOST = 'Other'

const PAIRED = /^([a-z][a-z0-9-]{1,40}) on ([A-Za-z0-9._-]{1,100})$/

export const hostOfKey = (key: { agentName: string; name: string }): string | null => {
  const match = PAIRED.exec(key.name)
  return match && match[1] === key.agentName ? match[2]! : null
}

export type HostGroup<K> = { id: string; host: string; paired: boolean; keys: K[] }

/**
 * Hosts in the order their newest key arrived, most recent first, with
 * "Other" always last; keys within a host in the order they were given.
 */
export const groupKeysByHost = <K extends { agentName: string; name: string; createdAt: string }>(
  keys: readonly K[],
): HostGroup<K>[] => {
  const groups = new Map<string, HostGroup<K>>()
  for (const key of keys) {
    const host = hostOfKey(key)
    // Keyed apart from the label, so a machine that really is called "Other"
    // is not merged with the keys whose names say nothing about a host.
    const id = host === null ? 'other' : `host:${host}`
    const group = groups.get(id) ?? { id, host: host ?? OTHER_HOST, paired: host !== null, keys: [] }
    group.keys.push(key)
    groups.set(id, group)
  }
  const newest = (group: HostGroup<K>) => Math.max(...group.keys.map((key) => Date.parse(key.createdAt)))
  return [...groups.values()].sort((a, b) => {
    if (a.paired !== b.paired) return a.paired ? -1 : 1
    return newest(b) - newest(a)
  })
}

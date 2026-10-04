import { admin } from '@/lib/db/client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A project by uuid or key. */
export const resolveProject = async <T extends { id: string; key: string }>(
  idOrKey: string,
  columns = 'id, key',
): Promise<T | null> => {
  const q = admin().from('projects').select(columns)
  const { data, error } = UUID.test(idOrKey)
    ? await q.eq('id', idOrKey).maybeSingle()
    : await q.eq('key', idOrKey.toUpperCase()).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as unknown as T | null) ?? null
}

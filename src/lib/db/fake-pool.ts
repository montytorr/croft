/**
 * A pool stand-in for tests, so generated SQL can be asserted without Postgres.
 *
 * Not collected by vitest (`include` is `*.test.ts`) and imported by nothing in
 * the application — it exists purely so the db client's SQL generation and the
 * helpers built on it are testable. The client caches its pool and its
 * json-column set on `globalThis`, which is the seam this uses; both are put
 * back afterwards so tests cannot leak into one another.
 */
type Captured<T> = { result: T; statements: string[]; parameters: unknown[][] }

export const withFakePool = async <T>(
  run: () => PromiseLike<T>,
  rows: Record<string, unknown>[] = [],
): Promise<Captured<T>> => {
  const statements: string[] = []
  const parameters: unknown[][] = []
  const scope = globalThis as typeof globalThis & {
    __croftPool?: unknown
    __croftJsonColumns?: unknown
  }
  const priorPool = scope.__croftPool
  const priorJson = scope.__croftJsonColumns

  scope.__croftJsonColumns = Promise.resolve(new Set<string>())
  scope.__croftPool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => {
        statements.push(sql)
        parameters.push(values)
        return { rows, rowCount: rows.length }
      },
      release: () => {},
    }),
  }

  try {
    return { result: await run(), statements, parameters }
  } finally {
    scope.__croftPool = priorPool
    scope.__croftJsonColumns = priorJson
  }
}

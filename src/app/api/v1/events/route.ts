import { createHash } from 'node:crypto'
import { authenticate } from '@/lib/api/auth'
import { admin } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

/**
 * Server-sent events for "something changed in this project".
 *
 * Deliberately NOT Supabase Realtime. That was the original plan only because
 * the container was already running; it has since been switched off to reclaim
 * CPU on a contended host, and re-enabling a whole service to notify three
 * clients would be the tail wagging the dog. SSE needs nothing but this route.
 *
 * It watches a single cheap indexed aggregate rather than streaming row
 * changes: the client only needs to know THAT something moved, then asks the
 * server for the new state through the normal render path. Shipping diffs
 * would mean a second, partial implementation of every view.
 */
const POLL_MS = 4000
// Ten minutes, unless the platform cuts requests sooner: App Runner ends any
// request at 120s, so there CROFT_SSE_MAX_SECONDS=100 closes the stream first
// and the browser's EventSource reconnects cleanly instead of on an error.
const MAX_LIFETIME_MS = (Number(process.env.CROFT_SSE_MAX_SECONDS) || 600) * 1000

export const GET = async (req: Request) => {
  const actor = await authenticate(req)
  if (!actor) return new Response('Unauthorized', { status: 401 })

  const url = new URL(req.url)
  const projectKey = url.searchParams.get('project')

  /**
   * One query, covering every store the UI can show.
   *
   * This compared `max(tasks.updated_at)` and `count(tasks)` and nothing else,
   * which is why the activity and lab pages could not be given live updates:
   * they would have held a subscription that could never fire. A subject moved
   * or a note logged moves nothing in a fingerprint made of tasks.
   *
   * In the database rather than four round trips from here, because this runs
   * every few seconds for every open tab.
   *
   * Scoped to what this viewer can see (076), and sent as a hash: the raw
   * string is timestamps and row counts, and a count of subjects or notes is
   * precisely what an outsider must not learn about someone's private work.
   * The client only ever compares it for equality.
   */
  const fingerprint = async (): Promise<string> => {
    const { data, error } = await admin().rpc('croft_pulse', {
      p_owner: actor.userId,
      p_project: projectKey ? projectKey.toUpperCase() : null,
    })
    // A failed read must not look like a change: returning something new would
    // refresh every open page on a loop for as long as the error lasts.
    if (error) return 'unavailable'
    const pulse = typeof data === 'string' ? data : String(data ?? '-')
    return createHash('sha256').update(pulse).digest('hex')
  }

  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))

      let last = await fingerprint()
      send('ready', last)

      const started = Date.now()
      timer = setInterval(async () => {
        // Bounded lifetime: a browser tab left open for days should not hold
        // a connection and a timer forever. EventSource reconnects on its own.
        if (Date.now() - started > MAX_LIFETIME_MS) {
          clearInterval(timer)
          controller.close()
          return
        }
        try {
          const next = await fingerprint()
          if (next !== last) {
            last = next
            send('changed', next)
          } else {
            // Comment frames keep proxies from closing an idle connection.
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          }
        } catch {
          // A transient failure should not kill the stream; the next tick
          // will try again.
        }
      }, POLL_MS)

      req.signal.addEventListener('abort', () => {
        clearInterval(timer)
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
    cancel() {
      clearInterval(timer)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Traefik does not buffer by default, but nginx would.
      'x-accel-buffering': 'no',
    },
  })
}

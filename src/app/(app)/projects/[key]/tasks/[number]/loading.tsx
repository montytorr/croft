import { cn } from '@/lib/utils'
import { PANE } from './styles'

/**
 * Skeleton for a task page. Mirrors the real two-column layout — the chips and
 * title over the body, the work log's composer, and the properties
 * column — so nothing jumps into place when the page arrives.
 */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="page-header border-border flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-4">
      <span className="skeleton h-2 w-10 rounded-full" />
      <span className="skeleton h-2 w-24 rounded-full" />
      <span className="skeleton h-2 w-40 rounded-full" />
    </div>
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="mx-auto max-w-[51.25rem] px-4 py-6 sm:px-6 lg:px-8">
          <div className="mb-2 flex items-center gap-1.5">
            <span className="skeleton h-[1.25rem] w-[4.5rem] rounded-md" />
            <span className="skeleton h-[1.25rem] w-24 rounded-full" />
          </div>
          <span className="skeleton mb-2.5 block h-6 w-4/5 rounded-md" />
          <span className="skeleton mb-7 block h-6 w-2/5 rounded-md" />
          <div className="max-w-[75ch]">
            {[92, 78, 96, 60, 88, 40].map((w, i) => (
              <span key={i} className="skeleton mb-2.5 block h-2 rounded-full" style={{ width: `${w}%` }} />
            ))}
          </div>
          <div className="mt-10 flex flex-col gap-2.5">
            <span className="skeleton h-1.5 w-16 rounded-full" />
            <span className="skeleton h-[5.75rem] w-full rounded-lg" />
          </div>
        </div>
      </div>
      <div className={cn(PANE, 'hidden w-[13.75rem] shrink-0 flex-col gap-5 px-4 py-5 lg:flex')}>
        {[3, 1, 2].map((rows, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <span className="skeleton h-1.5 w-14 rounded-full" />
            {Array.from({ length: rows }, (_, r) => (
              <span key={r} className="flex h-9 items-center gap-2">
                <span className="skeleton size-3 rounded-full" />
                <span className="skeleton h-2 rounded-full" style={{ width: `${[60, 44, 52][r]}%` }} />
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  </div>
)

export default Loading

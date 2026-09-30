import { cn } from '@/lib/utils'
import { RIG_PATHS } from '@/lib/brand-mark'

const RIG_TONES = ['var(--border-strong)', 'color-mix(in oklab, var(--border-strong) 55%, var(--bg))', 'var(--fg-subtle)']

/**
 * One empty state for the whole product (CROFT-308). There were fourteen,
 * each a line of grey text in its own padding, so an empty list looked like a
 * page that had failed to load.
 *
 * Three rig strips grow up a small hill: the product's mark, unploughed,
 * saying "nothing here yet" rather than "something broke". No accent — the
 * accent is for the thing to press, and an empty state's action carries it.
 * `compact` is for panels and popovers, where the field would be too much.
 */
export const EmptyState = ({
  title,
  hint,
  action,
  compact = false,
  as: Title = 'p',
  className,
}: {
  title: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
  compact?: boolean
  /** The title's element: `h1` where the empty state is the whole page. */
  as?: 'p' | 'h1' | 'h2'
  className?: string
}) => (
  <div
    className={cn(
      'enter-rise flex flex-col items-center justify-center text-center',
      compact ? 'gap-1 px-4 py-6' : 'gap-3 px-6 py-16',
      className,
    )}
  >
    {compact ? null : (
      <svg viewBox="3 4 26 24" className="h-8 w-auto" aria-hidden>
        {RIG_PATHS.map((d, i) => (
          <path
            key={d}
            d={d}
            fill={RIG_TONES[i]}
            stroke={RIG_TONES[i]}
            strokeWidth="0.8"
            strokeLinejoin="round"
            className="rig-grow"
            style={{ '--d': `${60 + i * 100}ms` } as React.CSSProperties}
          />
        ))}
      </svg>
    )}
    <Title className={cn('text-fg-muted font-medium', compact ? 'text-[0.75rem]' : 'text-[0.8125rem]')}>{title}</Title>
    {hint ? <p className="text-fg-subtle max-w-sm text-[0.75rem] leading-relaxed">{hint}</p> : null}
    {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
  </div>
)

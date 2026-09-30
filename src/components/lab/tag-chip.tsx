import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Tag } from '@/lib/lab/types'

const tone = (tag: Pick<Tag, 'color'>) =>
  tag.color && /^#[0-9a-f]{3,8}$/i.test(tag.color) ? tag.color : 'var(--fg-subtle)'

/**
 * A curated tag. The colour tints the chip and its dot; the word stays ink,
 * because an admin's colour is not measured against either ground.
 */
export const TagChip = ({
  tag,
  onRemove,
  active,
  className,
}: {
  tag: Pick<Tag, 'name' | 'color'>
  onRemove?: () => void
  /** Drawn pressed, for a tag that is currently a filter or a selection. */
  active?: boolean
  className?: string
}) => {
  const color = tone(tag)
  return (
    <span
      className={cn(
        'text-fg-muted inline-flex h-[1.25rem] max-w-full shrink-0 items-center gap-1 rounded-full border px-2 text-[0.6875rem] leading-none font-medium',
        active && 'text-fg',
        className,
      )}
      style={{
        borderColor: `color-mix(in oklab, ${color} ${active ? 60 : 30}%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${color} ${active ? 18 : 8}%, transparent)`,
      }}
    >
      <span className="size-[0.375rem] shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${tag.name}`}
          className="text-fg-subtle hover:text-fg -mr-1 grid size-3.5 place-items-center rounded-full transition-colors"
        >
          <X size={9} aria-hidden />
        </button>
      ) : null}
    </span>
  )
}

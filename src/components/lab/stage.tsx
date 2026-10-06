import { RIG_PATHS } from '@/lib/brand-mark'
import { cn } from '@/lib/utils'
import type { Stage, StageCategory } from '@/lib/lab/types'

/**
 * A stage's colour: its own, as an admin set it, or its category's token when
 * it has none. Used for glyphs, lane headlands and band edges — never for
 * running text, since an admin's colour is not measured against either ground.
 */
export const stageTone = (stage: Pick<Stage, 'color' | 'category'>) =>
  stage.color && /^#[0-9a-f]{3,8}$/i.test(stage.color) ? stage.color : `var(--stage-${stage.category})`

export const CATEGORY_LABEL: Record<StageCategory, string> = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
  dropped: 'Dropped',
}

/**
 * A stage as the mark's three rig strips, ploughed as far as the category has
 * got: planned is unbroken ground (outlines), active has its first strip
 * turned, completed is the whole field, dropped is a field left to go back —
 * faint, with a line struck through it. Shape carries the category and colour
 * carries the stage, so neither signal stands alone.
 */
export const StageGlyph = ({
  stage,
  size = 13,
  className,
}: {
  stage: Pick<Stage, 'color' | 'category' | 'name'>
  size?: number
  className?: string
}) => {
  const tone = stageTone(stage)
  const filled = (i: number) =>
    stage.category === 'completed' || (stage.category === 'active' && i === 0)
  const dropped = stage.category === 'dropped'
  return (
    <svg
      viewBox="3 4 25 24"
      width={size}
      height={size}
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <g stroke={tone} strokeWidth="1.8" strokeLinejoin="round" opacity={dropped ? 0.55 : 1}>
        {RIG_PATHS.map((d, i) => (
          <path key={d} d={d} fill={filled(i) || dropped ? tone : 'none'} fillOpacity={dropped ? 0.35 : 1} />
        ))}
      </g>
      {dropped ? <path d="M4.5 25.5 27 7" stroke={tone} strokeWidth="2.2" strokeLinecap="round" /> : null}
    </svg>
  )
}

/**
 * Where a subject is, said in full: the glyph, the stage's name and what kind
 * of stage it is. The one place the stage is set at reading size on a
 * subject's own page, so it can be read without finding the sidebar.
 */
export const StagePill = ({
  stage,
  className,
}: {
  stage: Pick<Stage, 'color' | 'category' | 'name'>
  className?: string
}) => (
  <span
    className={cn(
      'border-border-strong bg-surface text-fg inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-full border px-3 text-ui font-medium',
      className,
    )}
    title={`Stage: ${stage.name} (${CATEGORY_LABEL[stage.category].toLowerCase()})`}
  >
    <StageGlyph stage={stage} size={15} />
    <span className="truncate">{stage.name}</span>
    <span className="text-fg-muted text-aux font-normal">{CATEGORY_LABEL[stage.category]}</span>
  </span>
)

/** Glyph and name, for rows, chips and headings. */
export const StageBadge = ({
  stage,
  className,
}: {
  stage: Pick<Stage, 'color' | 'category' | 'name'>
  className?: string
}) => (
  <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
    <StageGlyph stage={stage} />
    <span className="truncate">{stage.name}</span>
  </span>
)

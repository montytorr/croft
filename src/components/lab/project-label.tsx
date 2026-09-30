import { cn } from '@/lib/utils'
import type { LabProject } from '@/lib/lab/types'

const tone = (project: Pick<LabProject, 'color'>) =>
  project.color && /^#[0-9a-f]{3,8}$/i.test(project.color) ? project.color : 'var(--fg-subtle)'

/**
 * A subject's lab project. Squarer than a tag — a project is where a subject
 * belongs, a tag is something it is about — with the colour on a small block
 * and the word left in ink, for the same reason as the tag chip: an admin's
 * colour is not measured against either ground.
 */
export const ProjectLabel = ({
  project,
  active,
  className,
}: {
  project: Pick<LabProject, 'name' | 'color'>
  /** Drawn pressed, for a project that is currently a filter or a selection. */
  active?: boolean
  className?: string
}) => {
  const color = tone(project)
  return (
    <span
      className={cn(
        'text-fg-muted inline-flex h-[1.25rem] max-w-full shrink-0 items-center gap-1.5 rounded-[5px] border px-1.5 text-[0.6875rem] leading-none font-medium',
        active && 'text-fg',
        className,
      )}
      style={{
        borderColor: `color-mix(in oklab, ${color} ${active ? 60 : 28}%, transparent)`,
        backgroundColor: active ? `color-mix(in oklab, ${color} 16%, transparent)` : undefined,
      }}
    >
      <span className="size-[0.4375rem] shrink-0 rounded-[2px]" style={{ backgroundColor: color }} aria-hidden />
      <span className="truncate">{project.name}</span>
    </span>
  )
}

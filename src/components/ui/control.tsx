'use client'

import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * Form controls.
 *
 * The look lives in globals.css, on the elements themselves: height, border,
 * radius, ground, font, the select's chevron, and the hover, focus, disabled,
 * invalid and placeholder states. A bare `<input>` is already right. What the
 * components add is only what a bare element cannot say: that it fills its row
 * (`w-full`), and the one compact size (`size="sm"`, 36px) for toolbars.
 * There is no third size; a control that needs one is a different control.
 *
 * A native select cannot be styled past a point, and the list that opens is
 * the platform's. That is the trade for keyboard behaviour and accessibility
 * for free, and it is the right one here.
 */

const sizes = {
  sm: 'control-sm',
  md: '',
} as const

type Size = keyof typeof sizes

// `size` is a native numeric attribute on input and select, so it has to be
// omitted before being redefined as a variant name.
type WithSize<T> = Omit<T, 'size'> & { size?: Size }

export const Input = forwardRef<HTMLInputElement, WithSize<React.ComponentProps<'input'>>>(
  ({ className, size = 'md', ...props }, ref) => (
    <input ref={ref} className={cn('w-full', sizes[size], className)} {...props} />
  ),
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn('w-full', className)} {...props} />,
)
Textarea.displayName = 'Textarea'

/**
 * `shrink-0` is not decoration: inside a flex row that scrolls sideways, a
 * select with no minimum was squeezed narrower than its own label, so
 * "All projects" wrapped inside a short control and the second line was
 * clipped. The row scrolls precisely so controls do not have to shrink. The
 * ellipsis in the base rule is for the case where the width is fixed and the
 * choice is longer.
 */
export const Select = forwardRef<HTMLSelectElement, WithSize<React.ComponentProps<'select'>>>(
  ({ className, size = 'md', children, ...props }, ref) => (
    <select ref={ref} className={cn('shrink-0', sizes[size], className)} {...props}>
      {children}
    </select>
  ),
)
Select.displayName = 'Select'

// Every variant has a rim, transparent where the variant has none, so a button
// is the same size in every variant and a disabled one can show its outline.
// Disabled is one look for all of them: a flat ground, a solid hairline and the
// muted ink, which is readable. Opacity is what made it unreadable.
const DISABLED =
  'disabled:border-border disabled:bg-bg-elevated disabled:text-fg-muted disabled:shadow-none disabled:brightness-100'

const buttonVariants = {
  // Flat fill. Brightening on hover, not fading: on the dark ground a faded
  // accent looks disabled.
  primary: 'border-accent bg-accent text-accent-fg hover:brightness-110',
  secondary: 'border-border-strong bg-surface text-fg hover:border-fg-subtle hover:bg-surface-raised',
  ghost: 'border-transparent text-fg-muted hover:bg-surface-raised hover:text-fg',
  quiet: 'border-transparent text-fg-muted hover:border-border hover:bg-surface-raised hover:text-fg',
  danger: 'border-transparent text-danger hover:bg-danger-subtle',
} as const

export const Button = forwardRef<
  HTMLButtonElement,
  WithSize<React.ComponentProps<'button'>> & { variant?: keyof typeof buttonVariants }
>(({ className, variant = 'secondary', size = 'md', ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap',
      'transition-[background-color,border-color,color,box-shadow,filter,transform] duration-[var(--dur-1)] ease-[var(--ease)]',
      'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
      'active:scale-[0.98] disabled:active:scale-100',
      size === 'sm' ? 'control-sm' : 'h-[var(--control-h)] px-3.5 text-ui',
      buttonVariants[variant],
      DISABLED,
      className,
    )}
    {...props}
  />
))
Button.displayName = 'Button'

/** Label above a control, used down the task-detail sidebar. */
export const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className="text-fg-subtle text-aux font-medium">{label}</span>
    {children}
  </label>
)

/**
 * The compact input used inside popovers, pickers and rows. It is the shared
 * field at the compact size, nothing more: it used to carry its own radius,
 * ground and focus treatment, which is how seven of them drifted apart.
 */
export const InlineInput = forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn('control-sm w-full', className)} {...props} />,
)
InlineInput.displayName = 'InlineInput'

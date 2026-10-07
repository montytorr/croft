/**
 * The one label style down the task page: every panel heading and every
 * sidebar section. The app's shared `.pane-label` (globals.css) since v0.3, so
 * the todo page names its sections the way the subject page does. Six panels and eight sections had drifted between two sizes
 * and two greys, which read as eight different kinds of thing.
 */
export const LABEL = 'pane-label'

/** The count beside a label: the shared `.count` stone, not a trailing digit. */
export const COUNT = 'count normal-case'

/** A composer's shell: the shared field's rim around a textarea and its actions; it turns to the accent while typing. */
export const COMPOSER = 'control-shell overflow-hidden'

/** The textarea inside a composer: no rim of its own, the shell has it. */
export const COMPOSER_FIELD = 'control-bare block max-h-[40vh] min-h-[3.625rem] w-full resize-y px-3 py-2.5 leading-relaxed'

/**
 * The properties column: a solid pane beside the canvas, set off by one
 * hairline down its inner edge.
 *
 * Deliberately no backdrop filter or transform: either would make this column
 * the containing block of the resolution dialog that opens from inside it.
 */
export const PANE = 'bg-bg-elevated border-border border-l'

/**
 * The sidebar's property list: a label beside its value rather than a
 * heading above it, the way Linear's panel reads. The label column is a
 * fixed width so every value starts at the same edge, and it never grows —
 * a long value truncates in its own column instead of pushing the row wide.
 */
export const ROW_LABEL = 'text-fg-subtle w-[4.75rem] shrink-0 text-[0.75rem]'

/** A property row's shell: flat hover fill, ~28px tall, never wider than the pane. */
export const ROW = 'row-hover -mx-1.5 flex min-w-0 min-h-[1.75rem] items-center gap-2 rounded-md px-1.5'

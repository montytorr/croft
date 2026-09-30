/**
 * A croft on a trail: what the product is named for, drawn large for the one
 * page that has room for it. Flat, in the mark's own geometry — rounded
 * stones, no shading — so it reads as the logo grown up rather than a render.
 * The stones settle into place one after another; a dotted path leads to them.
 * The top stone carries the instance's accent.
 *
 * Pure SVG and CSS (`.login-stone` in globals.css), so it costs no script and
 * holds still for anyone who has asked for reduced motion.
 */
const STONES = [
  { x: 28, y: 214, w: 184, fill: 'var(--border-strong)' },
  { x: 44, y: 176, w: 152, fill: 'color-mix(in oklab, var(--fg-subtle) 55%, var(--border-strong))' },
  { x: 60, y: 138, w: 120, fill: 'var(--fg-subtle)' },
  { x: 78, y: 100, w: 84, fill: 'color-mix(in oklab, var(--fg-muted) 70%, var(--fg-subtle))' },
  { x: 96, y: 62, w: 48, fill: 'var(--accent)' },
]
const HEIGHT = 30

export const CroftIllustration = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 240 270" className={className} aria-hidden>
    <path
      d="M-10 262 C 20 258, 18 250, 40 248"
      fill="none"
      stroke="var(--fg-subtle)"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeDasharray="0.5 7"
      opacity="0.6"
    />
    {/* Bottom first, so each stone lands on the one already there. */}
    {STONES.map((s, i) => (
      <g key={i} className="login-stone" style={{ '--d': `${200 + i * 120}ms` } as React.CSSProperties}>
        <rect x={s.x} y={s.y} width={s.w} height={HEIGHT} rx={HEIGHT / 2} fill={s.fill} />
      </g>
    ))}
  </svg>
)

/**
 * A field of runrig: five strips of ploughed ground sweeping up a hillside,
 * which is the mark grown to the size of the one page that has room for it.
 * Flat, in the mark's own geometry — curved strips with the furrows left as
 * paper — so it reads as the logo at rest rather than a render.
 *
 * The strips grow up the hill one after another. One carries the mark's
 * colour (--brand-mark, the instance's brand), not the accent: the accent is
 * reserved for the thing to press, and on this page that is "Sign in".
 *
 * Pure SVG and CSS (`.rig-grow` in globals.css), so it costs no script and
 * holds still for anyone who has asked for reduced motion.
 */
const STRIPS = [
  { d: 'M4 200C19.6 138.6 109.2 77.2 118 14L136.4 14C134.7 77.2 52 138.6 43.2 200Z', fill: 'var(--border-strong)' },
  { d: 'M52.2 200C59.3 138.6 140.4 77.2 140.4 14L158.8 14C165.9 77.2 91.6 138.6 91.4 200Z', fill: 'color-mix(in oklab, var(--border-strong) 55%, var(--bg))' },
  { d: 'M100.4 200C99 138.6 171.6 77.2 162.8 14L181.2 14C197.1 77.2 131.3 138.6 139.6 200Z', fill: 'var(--border-strong)' },
  { d: 'M148.6 200C138.7 138.6 202.8 77.2 185.2 14L203.6 14C228.2 77.2 171 138.6 187.8 200Z', fill: 'var(--brand-mark)' },
  { d: 'M196.8 200C178.4 138.6 233.9 77.2 207.6 14L226 14C259.4 77.2 210.7 138.6 236 200Z', fill: 'color-mix(in oklab, var(--border-strong) 55%, var(--bg))' },
]

export const CroftIllustration = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 240 210" className={className} aria-hidden>
    {STRIPS.map((s, i) => (
      <path
        key={s.d}
        d={s.d}
        fill={s.fill}
        stroke={s.fill}
        strokeWidth="3"
        strokeLinejoin="round"
        className="rig-grow"
        style={{ '--d': `${160 + i * 110}ms` } as React.CSSProperties}
      />
    ))}
  </svg>
)

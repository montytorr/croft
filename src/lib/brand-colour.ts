/**
 * An instance's accent, turned into the four tokens each theme needs.
 *
 * An admin picks one colour. Used as-is it is right in at most one theme: a
 * navy that reads well on white disappears on the near-black ground, and a
 * yellow that glows on the ground is illegible on white. So each theme gets
 * its own variant, moved towards black or white only as far as it takes to
 * clear a contrast line against that theme's ground. The hue stays; that is
 * what makes it still the brand.
 *
 * Pure, and free of anything server-only, so the settings page can preview
 * exactly what saving would produce.
 */

export type AccentTokens = {
  accent: string
  accentFg: string
  accentSubtle: string
  ring: string
}

export type Palette = { light: AccentTokens; dark: AccentTokens }

export const HEX = /^#[0-9a-f]{6}$/i

/** The stock accent, dark variant: heather, the strips on the stock favicon. */
export const STOCK_MARK = '#d89bc4'

const WHITE = '#ffffff'
/** The two grounds an accent is measured against: paper and peat (--bg). */
export const LIGHT_GROUND = '#f6f2ea'
export const DARK_GROUND = '#161316'
/** Ink, for a fill too light to carry white (--fg, light). */
export const DARK_TEXT = '#221c20'

/**
 * Text and links carry the accent, so the light variant has to be readable
 * text on paper: 4.5. The dark one is held a little higher, 5.5, so a brand
 * never comes out much dimmer on peat than the stock heather (8.26) it
 * replaces.
 */
const LIGHT_MIN = 4.5
const DARK_MIN = 5.5

type Rgb = [number, number, number]

const parse = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const format = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`

const toLinear = (c: number) => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

const fromLinear = (c: number) => {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
  return s * 255
}

const luminance = (hex: string) => {
  const [r, g, b] = parse(hex).map(toLinear) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2 contrast ratio between two colours, 1 to 21. */
export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// OKLab, so that "a little lighter" keeps the hue instead of washing it grey
// the way mixing in sRGB does.
const toOklab = (hex: string): Rgb => {
  const [r, g, b] = parse(hex).map(toLinear) as Rgb
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

const fromOklab = ([L, a, b]: Rgb): string => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return format([
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ])
}

/** `t` of the way from `a` to `b`. */
export const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [toOklab(a), toOklab(b)]
  return fromOklab([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * t) as Rgb)
}

/**
 * The least change of lightness that clears `min` against `ground`. Only L
 * moves — chroma and hue stay — because mixing towards white also mixes
 * towards grey, and a navy lifted that way comes out a washed slate rather
 * than the same blue, brighter. Out-of-gamut results are clamped per channel.
 */
const clear = (hex: string, direction: 1 | -1, ground: string, min: number): string => {
  if (contrast(hex, ground) >= min) return hex
  const [L, a, b] = toOklab(hex)
  for (let step = 1; step <= 100; step++) {
    const candidate = fromOklab([Math.min(1, Math.max(0, L + direction * step * 0.01)), a, b])
    if (contrast(candidate, ground) >= min) return candidate
  }
  return direction === 1 ? '#ffffff' : '#000000'
}

/**
 * White on the fill unless it would be unreadable. 3 rather than 4.5 because
 * this is button text, medium weight, and a stricter line would flip button
 * text to ink on mid-tone accents that carry white perfectly well. The stock
 * dark heather is below it, which is why its buttons are set in ink.
 */
const onFill = (fill: string) => (contrast(WHITE, fill) >= 3 ? WHITE : DARK_TEXT)

export const paletteFor = (hex: string): Palette => {
  const base = hex.toLowerCase()
  const light = clear(base, -1, LIGHT_GROUND, LIGHT_MIN)
  const dark = clear(base, 1, DARK_GROUND, DARK_MIN)
  return {
    light: { accent: light, accentFg: onFill(light), accentSubtle: mix(light, LIGHT_GROUND, 0.88), ring: light },
    dark: { accent: dark, accentFg: onFill(dark), accentSubtle: mix(dark, DARK_GROUND, 0.8), ring: dark },
  }
}

const block = (t: AccentTokens) =>
  `--accent:${t.accent};--accent-fg:${t.accentFg};--accent-subtle:${t.accentSubtle};--ring:${t.ring};`

/**
 * The override stylesheet. `html:root` outranks the `:root` in globals.css
 * by specificity, so it wins wherever the tag lands in the document. Every
 * value comes out of `format`, so nothing an admin typed reaches the CSS.
 */
export const paletteCss = (p: Palette): string =>
  `html:root{${block(p.light)}--brand-mark:${p.dark.accent};}html:root.dark{${block(p.dark)}}`

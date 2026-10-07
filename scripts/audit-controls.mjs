#!/usr/bin/env node
/**
 * Form-control audit: walks every page of a running Croft, opens the popovers,
 * dialogs and inline editors it can reach, and measures every field and button
 * it finds. A control that breaks the shared standard is flagged, and the run
 * exits 1 so it can gate a change.
 *
 *   CROFT_URL=http://localhost:3000 CROFT_EMAIL=you@example.com \
 *   CROFT_PASSWORD=... npm run audit:controls
 *
 * Optional:
 *   AUDIT_WIDTHS=1440,375        viewports (375 is a touch device: the 16px field rule applies)
 *   AUDIT_THEMES=light,dark
 *   AUDIT_OUT=controls.json      the full per-control record
 *   AUDIT_SHOTS=./shots          a screenshot of every page and every opened state
 *   AUDIT_ONLY=/settings,/todos  only pages whose path contains one of these
 *
 * Recorded per control: height, font-size, font-family, border-style,
 * border-color, background, appearance, padding, radius. Probed per control:
 * what it looks like disabled, focused and invalid, so a state no page happens
 * to show is still held to the standard.
 *
 * The standard it checks:
 *   fields and buttons    36px (compact, one size) or 40-44px
 *   font                  the interface font, at least 15px (16px on a touch screen)
 *   border                solid, never dashed
 *   select                appearance none, with room for the chevron on the right
 *   disabled              solid, readable (4.5:1), never dashed; an empty one says why
 *   checkbox, radio       a hit area of at least 24px
 *   exempt                data-inline-edit (a title edited in place) and data-surface (a full-page source editor)
 *   focus, invalid        a visible change
 *
 * Needs a browser: `npx playwright-core install chromium` once. A manual check
 * against a seeded instance, not part of CI, which has no running app.
 */
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = (process.env.CROFT_URL || 'http://localhost:3000').replace(/\/$/, '')
const WIDTHS = (process.env.AUDIT_WIDTHS || '1440,375').split(',').map(Number)
const THEMES = (process.env.AUDIT_THEMES || 'light,dark').split(',')
const OUT = process.env.AUDIT_OUT
const SHOTS = process.env.AUDIT_SHOTS
const ONLY = (process.env.AUDIT_ONLY || '').split(',').filter(Boolean)

const email = process.env.CROFT_EMAIL
const password = process.env.CROFT_PASSWORD
if (!email || !password) {
  console.error('Set CROFT_EMAIL and CROFT_PASSWORD (an account on the instance being checked).')
  process.exit(2)
}

const login = async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    console.error(`Sign-in failed: ${res.status}`)
    process.exit(2)
  }
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .map((pair) => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: BASE }))
}

const cookies = await login()
const authed = { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), origin: BASE, 'content-type': 'application/json' }

const connectCode = async () => {
  const res = await fetch(`${BASE}/api/v1/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'audit-box', runtimes: ['claude'] }),
  }).catch(() => null)
  return res?.ok ? (await res.json()).data.userCode : null
}

const resetPath = async () => {
  const list = await fetch(`${BASE}/api/v1/users`, { headers: authed }).then((r) => r.json()).catch(() => null)
  const other = list?.data?.find?.((u) => u.email !== email)
  if (!other) return null
  const res = await fetch(`${BASE}/api/v1/users/${other.id}/password-reset`, { method: 'POST', headers: authed, body: '{}' })
    .then((r) => r.json())
    .catch(() => null)
  const url = res?.data?.url ?? res?.data?.link ?? res?.data?.resetUrl
  return url ? new URL(url).pathname : null
}

const code = await connectCode()
const reset = await resetPath()
const PAGES = [
  { path: '/login', anonymous: true },
  ...(reset ? [{ path: reset, anonymous: true }] : []),
  { path: '/' }, { path: '/subjects/1' }, { path: '/subjects/1?tab=todos' }, { path: '/subjects/1?tab=notes' },
  { path: '/subjects/1?tab=log' }, { path: '/subjects/1?tab=files' }, { path: '/subjects/1?tab=details' },
  { path: '/subjects/2' }, { path: '/subjects/3?tab=details' },
  { path: '/todos' }, { path: '/board' }, { path: '/search?q=a' }, { path: '/search?q=zzzz-nothing' }, { path: '/activity' },
  { path: '/settings' }, { path: '/settings/keys' }, { path: '/users' }, { path: '/connect' },
  ...(code ? [{ path: `/connect/${code}` }] : []),
  { path: '/projects/T/tasks/1' },
].filter((p) => ONLY.length === 0 || ONLY.some((o) => p.path.includes(o)))

const DESTRUCTIVE = /sign out|log out|logout|delete|remove|revoke|archive|ban|deactivate|disable|take back|deny|approve|publish|reset|clear|discard|conclude|restore/i
const OPENERS = 'button, summary, [role="tab"], [role="combobox"], [aria-haspopup], [role="button"], [title^="Click"], [class*="cursor-text"]'

/** Runs in the page. Marks what it has seen, so a later call returns only what is new. */
const collect = ({ record, mobile }) => {
  const FIELD_SELECTOR =
    'input:not([type="hidden"]), select, textarea, button, [contenteditable="true"], [role="combobox"], [role="switch"], [role="checkbox"]'
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return [r, g, b, a / 255]
  }
  const over = (top, under) => {
    const a = top[3] + under[3] * (1 - top[3])
    if (a === 0) return [0, 0, 0, 0]
    return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a)
  }
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  const groundOf = (el) => {
    let ground = rgba(getComputedStyle(document.documentElement).backgroundColor)
    const chain = []
    for (let n = el; n; n = n.parentElement) chain.unshift(n)
    ground = over(ground, [255, 255, 255, 1])
    for (const n of chain) ground = over(rgba(getComputedStyle(n).backgroundColor), ground)
    return ground
  }
  const effectiveOpacity = (el) => {
    let o = 1
    for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity)
    return o
  }
  const textContrast = (el, colour) => {
    const o = effectiveOpacity(el)
    const parentGround = groundOf(el.parentElement ?? el)
    const own = rgba(getComputedStyle(el).backgroundColor)
    const ground = over(own, parentGround)
    const fg = rgba(colour)
    const blended = over([fg[0], fg[1], fg[2], fg[3] * o], ground)
    const shownGround = over([ground[0], ground[1], ground[2], ground[3] * o], parentGround)
    return Math.round(ratio(blended, shownGround) * 100) / 100
  }
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'select') return 'select'
    if (tag === 'textarea') return 'textarea'
    if (el.isContentEditable) return 'editor'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'file') return 'file'
      if (['button', 'submit', 'reset'].includes(t)) return 'button'
      if (t === 'color' || t === 'range') return t
      return 'input'
    }
    if (el.getAttribute('role') === 'combobox') return 'combobox'
    if (['switch', 'checkbox'].includes(el.getAttribute('role'))) return 'switch'
    if (tag === 'button') {
      if (el.closest('[role="menu"], [role="listbox"], [cmdk-list], [role="tablist"], [role="group"][aria-label]'))
        return 'item'
      if (el.getAttribute('role') && el.getAttribute('role') !== 'button') return 'item'
      const cs = getComputedStyle(el)
      const bg = rgba(cs.backgroundColor)
      const rim = cs.borderTopStyle !== 'none' && cs.borderTopWidth !== '0px' && rgba(cs.borderTopColor)[3] > 0
      const box = el.getBoundingClientRect()
      // A card or a drop zone that happens to be a button, and a swatch or an icon: neither is a button to size.
      if (box.height > 56) return 'card'
      if (!el.textContent.trim() && Math.abs(box.width - box.height) < 2) return 'icon'
      return bg[3] > 0.05 || rim ? 'button' : 'ghost'
    }
    return 'other'
  }
  const FONT_OF = (cs) => cs.fontFamily.split(',')[0].replace(/["']/g, '').trim()
  const bodyFont = FONT_OF(getComputedStyle(document.body))

  const measureOf = (el, kind) => {
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const wrap = el.closest('label')
    const wrapRect = wrap ? wrap.getBoundingClientRect() : rect
    const reaches = (dx, dy) => {
      const hit = document.elementFromPoint(rect.left + rect.width / 2 + dx, rect.top + rect.height / 2 + dy)
      return el.contains(hit) || (wrap !== null && wrap.contains(hit))
    }
    const hit24 = (rect.width >= 23.5 && rect.height >= 23.5) || (reaches(-11, 0) && reaches(11, 0) && reaches(0, -11) && reaches(0, 11))
    const out = {
      height: Math.round(rect.height * 10) / 10,
      width: Math.round(rect.width),
      fontSize: parseFloat(cs.fontSize),
      fontFamily: FONT_OF(cs),
      borderStyle: cs.borderTopStyle,
      borderWidth: cs.borderTopWidth,
      borderColor: cs.borderTopColor,
      background: cs.backgroundColor,
      appearance: cs.appearance,
      padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
      paddingRight: parseFloat(cs.paddingRight),
      radius: cs.borderTopLeftRadius,
      color: cs.color,
      opacity: Math.round(effectiveOpacity(el) * 100) / 100,
      hit: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      hit24,
    }
    if (kind === 'select') {
      const text = el.selectedOptions?.[0]?.textContent?.trim() ?? ''
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      const needed = ctx.measureText(text).width
      const room = rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) * 2
      out.selectedText = text
      out.options = el.options.length
      out.textOverflow = cs.textOverflow
      out.clipped = needed > room + 1 && cs.textOverflow !== 'ellipsis'
      out.hasReason = text.length > 0 || Boolean(el.title || el.getAttribute('aria-description') || el.getAttribute('aria-describedby'))
    }
    if (kind === 'button' || kind === 'ghost') out.clipped = el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.overflow === 'hidden'
    return out
  }

  const probe = (el, kind) => {
    const result = {}
    const transition = el.style.transition
    el.style.transition = 'none'
    const canDisable = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(el.tagName)
    if (canDisable) {
      const wasDisabled = el.disabled
      el.disabled = true
      const cs = getComputedStyle(el)
      result.disabled = {
        borderStyle: cs.borderTopStyle,
        opacity: Math.round(effectiveOpacity(el) * 100) / 100,
        contrast: ['checkbox', 'radio', 'icon'].includes(kind) ? null : textContrast(el, cs.color),
        cursor: cs.cursor,
      }
      el.disabled = wasDisabled
    }
    if (['input', 'textarea', 'select', 'button', 'ghost'].includes(kind)) {
      const sig = () => {
        const cs = getComputedStyle(el)
        return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderTopColor, cs.backgroundColor].join('|')
      }
      const was = document.activeElement
      const focused = was === el
      try {
        if (focused) el.blur()
        const before = sig()
        if (!el.disabled) {
          el.focus({ focusVisible: true })
          result.focusVisible = sig() !== before
        }
        el.blur()
        if (focused) el.focus()
        else was?.focus?.()
      } catch {
        result.focusVisible = null
      }
    }
    if (['input', 'textarea', 'select'].includes(kind) && !el.disabled) {
      const before = getComputedStyle(el).borderTopColor + getComputedStyle(el).boxShadow
      const had = el.getAttribute('aria-invalid')
      el.setAttribute('aria-invalid', 'true')
      const after = getComputedStyle(el).borderTopColor + getComputedStyle(el).boxShadow
      result.invalidStyled = before !== after
      if (had === null) el.removeAttribute('aria-invalid')
      else el.setAttribute('aria-invalid', had)
    }
    if (['input', 'textarea'].includes(kind) && el.placeholder) {
      const cs = getComputedStyle(el, '::placeholder')
      const o = Number(cs.opacity)
      const fg = rgba(cs.color)
      const ground = over(rgba(getComputedStyle(el).backgroundColor), groundOf(el.parentElement ?? el))
      result.placeholderContrast = Math.round(ratio(over([fg[0], fg[1], fg[2], fg[3] * o], ground), ground) * 100) / 100
    }
    void getComputedStyle(el).borderTopColor
    el.style.transition = transition
    return result
  }

  const label = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.title ||
      el.textContent?.trim().replace(/\s+/g, ' ') || el.id || el.tagName).slice(0, 48)

  const found = []
  for (const el of document.querySelectorAll(FIELD_SELECTOR)) {
    if (el.dataset.auditSeen) continue
    const rect = el.getBoundingClientRect()
    el.dataset.auditSeen = '1'
    if (!record) continue
    const cs = getComputedStyle(el)
    const kind = kindOf(el)
    if (kind === 'other' || cs.visibility === 'hidden' || cs.display === 'none') continue
    const hidden = rect.width === 0 || rect.height === 0
    const invisible = effectiveOpacity(el) === 0
    if (hidden && !['checkbox', 'radio'].includes(kind)) continue
    if (el.closest('.ProseMirror') && el !== el.closest('.ProseMirror')) continue
    const m = measureOf(el, kind)
    found.push({
      kind,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      label: label(el),
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      invisible,
      bare: el.classList.contains('control-bare') && Boolean(el.closest('.control-shell')),
      exempt: el.hasAttribute('data-inline-edit') || el.hasAttribute('data-surface'),
      bodyFont,
      mobile,
      ...m,
      probe: probe(el, kind),
    })
  }
  return found
}

const FIELD_KINDS = new Set(['input', 'select', 'textarea', 'combobox', 'editor', 'file'])
const COMPACT = 36

/** The standard, as flags. A flag names what is off and the value that is. */
const flagsOf = (c) => {
  const flags = []
  if (c.invisible) return flags
  // An in-place title edit sets itself as the heading it replaces, and a full-page source editor is a surface
  // rather than a field. A composer's textarea has no rim because its shell has the field's.
  if (c.exempt) return flags
  if (c.bare) return c.fontFamily === c.bodyFont ? flags : [`font ${c.fontFamily}`]
  const isField = FIELD_KINDS.has(c.kind)
  const isButton = c.kind === 'button'
  if ((isField && c.kind !== 'textarea' && c.kind !== 'editor') || isButton) {
    const h = Math.round(c.height)
    if (h !== COMPACT && (h < 40 || h > 44)) flags.push(`height ${c.height}px`)
  }
  if (isField || isButton) {
    if (c.fontFamily !== c.bodyFont) flags.push(`font ${c.fontFamily}`)
    const floor = c.mobile && isField ? 16 : 12.9
    if (c.fontSize < floor) flags.push(`font-size ${c.fontSize}px`)
    if (c.borderStyle === 'dashed' || c.borderStyle === 'dotted') flags.push(`border ${c.borderStyle}`)
  }
  if (isField && c.borderStyle === 'none' && c.kind !== 'editor') flags.push('field has no border')
  if (c.kind === 'select') {
    if (c.appearance !== 'none') flags.push(`appearance ${c.appearance}`)
    if (c.paddingRight < 24) flags.push(`padding-right ${c.paddingRight}px leaves no room for the chevron`)
    if (c.clipped) flags.push('text cut off, no ellipsis')
    if (c.disabled && !c.hasReason) flags.push('disabled and empty with no reason')
    if (!c.disabled && c.options === 0) flags.push('no options')
  }
  if ((c.kind === 'checkbox' || c.kind === 'radio') && !c.hit24) flags.push(`hit area under 24px (${c.hit})`)
  if ((c.kind === 'ghost' || c.kind === 'icon') && !c.hit24) flags.push(`hit area under 24px (${c.hit})`)
  const d = c.probe.disabled
  if (d) {
    if (d.borderStyle === 'dashed' || d.borderStyle === 'dotted') flags.push(`disabled border ${d.borderStyle}`)
    if (d.contrast !== null && d.contrast < 4.5) flags.push(`disabled contrast ${d.contrast}`)
  }
  if (c.probe.focusVisible === false) flags.push('no focus indicator')
  if (c.probe.invalidStyled === false) flags.push('no invalid state')
  if (c.probe.placeholderContrast !== undefined && c.probe.placeholderContrast < 4.5)
    flags.push(`placeholder contrast ${c.probe.placeholderContrast}`)
  return flags
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'home'

const auditConfig = async (width, theme) => {
  const browser = await chromium.launch()
  const mobile = width < 768
  const config = `${width}-${theme}`
  const rows = []
  const newContext = async (anonymous) => {
    const context = await browser.newContext({
      viewport: { width, height: mobile ? 800 : 900 },
      ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    })
    await context.addInitScript((t) => {
      try { localStorage.setItem('theme', t) } catch {}
    }, theme)
    if (!anonymous) await context.addCookies(cookies)
    return context
  }
  const contexts = { anon: await newContext(true), authed: await newContext(false) }

  for (const spec of PAGES) {
    const context = spec.anonymous ? contexts.anon : contexts.authed
    const page = await context.newPage()
    try {
      await auditPage({ spec, page, rows, config, mobile })
    } catch (error) {
      console.error(`Skipped the rest of ${spec.path} at ${config}: ${error.message.split('\n')[0]}`)
    }
    await page.close().catch(() => undefined)
  }
  await browser.close().catch(() => undefined)
  return rows
}

const auditPage = async ({ spec, page, rows, config, mobile }) => {
  {
    const open = async () => {
      await page.goto(`${BASE}${spec.path}`, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
      await page.waitForTimeout(700)
    }
    const shoot = async (name) => {
      if (!SHOTS) return
      await mkdir(SHOTS, { recursive: true })
      await page.screenshot({ path: join(SHOTS, `${name}-${config}.png`) }).catch(() => undefined)
    }
    const record = async (state) => {
      const found = await page.evaluate(collect, { record: true, mobile }).catch(() => [])
      for (const c of found) rows.push({ page: spec.path, state, config, ...c, flags: flagsOf(c) })
      await page.waitForTimeout(180)
      return found.length
    }

    await open()
    await record('page')
    await shoot(slug(spec.path))

    const candidates = await page.evaluate((sel) => {
      const out = []
      document.querySelectorAll(sel).forEach((el, index) => {
        const rect = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (!rect.width || !rect.height || cs.visibility === 'hidden' || el.disabled) return
        const label = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
        out.push({ index, label })
      })
      return out
    }, OPENERS)

    const seen = new Set()
    for (const { index, label } of candidates) {
      const key = `${index}:${label}`
      if (seen.has(key) || DESTRUCTIVE.test(label)) continue
      seen.add(key)
      await open()
      await page.evaluate(collect, { record: false, mobile })
      const opener = page.locator(OPENERS).nth(index)
      const before = page.url()
      try {
        await opener.click({ timeout: 1500 })
      } catch {
        continue
      }
      await page.waitForTimeout(250)
      if (page.url() !== before) continue
      const state = `${label || `#${index}`}`
      const count = await record(state)
      if (count > 0) await shoot(`${slug(spec.path)}__${slug(label || `n${index}`)}`)

      const inner = await page.evaluate((sel) => {
        const out = []
        document.querySelectorAll(sel).forEach((el, i) => {
          const rect = el.getBoundingClientRect()
          if (!rect.width || !rect.height || el.disabled || el.dataset.auditInner) return
          if (!el.closest('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [popover], form')) return
          const label = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)
          out.push({ index: i, label })
        })
        return out
      }, OPENERS)
      for (const next of inner.slice(0, 10)) {
        if (DESTRUCTIVE.test(next.label) || /^(save|create|add|submit|cancel|close|post|send|update)\b/i.test(next.label)) continue
        try {
          await page.locator(OPENERS).nth(next.index).click({ timeout: 1000 })
          await page.waitForTimeout(200)
          if (page.url() !== before) break
          await record(`${state} > ${next.label || `#${next.index}`}`)
        } catch {
          // the element moved or closed: nothing more to open from it
        }
      }
    }

    await open()
    await page.evaluate(collect, { record: false, mobile })
    for (const combo of ['Meta+k', 'Control+k']) {
      await page.keyboard.press(combo)
      await page.waitForTimeout(250)
    }
    await record('command palette')
  }
}

const configs = WIDTHS.flatMap((w) => THEMES.map((t) => [w, t]))
const all = (await Promise.all(configs.map(([w, t]) => auditConfig(w, t)))).flat()

const flagged = all.filter((r) => r.flags.length > 0)
const byKind = {}
for (const r of all) {
  if (r.invisible || r.exempt || r.bare) continue
  const bucket = (byKind[r.kind] ??= { count: 0, heights: {}, fonts: {}, borders: {}, radii: {} })
  bucket.count += 1
  for (const [field, key] of [['heights', 'height'], ['fonts', 'fontFamily'], ['borders', 'borderStyle'], ['radii', 'radius']]) {
    const value = String(r[key])
    bucket[field][value] = (bucket[field][value] ?? 0) + 1
  }
}

console.log(`\nControls measured: ${all.length} (${configs.map(([w, t]) => `${w} ${t}`).join(', ')})`)
for (const [kind, b] of Object.entries(byKind)) {
  const top = (o) => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} x${n}`).join(', ')
  console.log(`\n${kind} (${b.count})\n  height   ${top(b.heights)}\n  font     ${top(b.fonts)}\n  border   ${top(b.borders)}\n  radius   ${top(b.radii)}`)
}

const grouped = new Map()
for (const r of flagged) {
  for (const f of r.flags) {
    const key = `${r.kind}: ${f}`
    const entry = grouped.get(key) ?? new Map()
    const where = `${r.page} [${r.state}] ${r.tag}${r.type ? `[${r.type}]` : ''} "${r.label}"`
    entry.set(where, (entry.get(where) ?? new Set()).add(r.config))
    grouped.set(key, entry)
  }
}
console.log(`\nFlagged: ${flagged.length} control record(s), ${grouped.size} distinct problem(s)\n`)
for (const [key, entry] of [...grouped].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`${key}  (${entry.size} control${entry.size === 1 ? '' : 's'})`)
  for (const [where, configsSeen] of [...entry].slice(0, 6)) console.log(`    ${where}  @ ${[...configsSeen].join(', ')}`)
  if (entry.size > 6) console.log(`    ... and ${entry.size - 6} more`)
}

if (OUT) await writeFile(OUT, JSON.stringify({ summary: byKind, controls: all }, null, 2))
console.log(flagged.length === 0 ? '\nEvery control meets the standard.' : `\n${grouped.size} problem(s) found.`)
process.exit(flagged.length === 0 ? 0 : 1)

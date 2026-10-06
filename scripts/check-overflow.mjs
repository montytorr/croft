#!/usr/bin/env node
/**
 * Page-overflow check: opens every page of a running Croft at phone and tablet
 * widths and fails if the page scrolls sideways or anything pokes past the
 * edge outside a container that scrolls on purpose (the board, a table, the
 * tab bar).
 *
 *   CROFT_URL=http://localhost:3000 CROFT_EMAIL=you@example.com \
 *   CROFT_PASSWORD=... npm run check:overflow
 *
 * Needs a browser: `npx playwright-core install chromium` once. It is a manual
 * check against a seeded instance, not part of CI, which has no running app.
 */
import { chromium } from 'playwright-core'

const BASE = (process.env.CROFT_URL || 'http://localhost:3000').replace(/\/$/, '')
const WIDTHS = (process.env.CROFT_WIDTHS || '320,375,768,1024,1440').split(',').map(Number)
const PAGES = [
  '/', '/subjects/1', '/subjects/1?tab=todos', '/subjects/1?tab=notes', '/subjects/1?tab=log',
  '/subjects/1?tab=files', '/subjects/1?tab=details', '/todos', '/board', '/search?q=a', '/activity',
  '/settings', '/settings/keys', '/users', '/connect', '/projects/T/tasks/1', '/login',
]

const email = process.env.CROFT_EMAIL
const password = process.env.CROFT_PASSWORD
if (!email || !password) {
  console.error('Set CROFT_EMAIL and CROFT_PASSWORD (an account on the instance being checked).')
  process.exit(2)
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify({ email, password }),
})
if (!login.ok) {
  console.error(`Sign-in failed: ${login.status}`)
  process.exit(2)
}
const cookies = login.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .map((pair) => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: BASE }))

const measure = () => {
  const root = document.documentElement
  const escapes = []
  for (const el of document.querySelectorAll('body *')) {
    const box = el.getBoundingClientRect()
    if (!box.width || box.right <= root.clientWidth + 1) continue
    let clipped = false
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(up).overflowX)) {
        clipped = true
        break
      }
    }
    if (!clipped && escapes.length < 3) escapes.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`)
  }
  const scrollRoots = [...document.querySelectorAll('[data-scroll-root], main')].some((el) => el.scrollWidth > el.clientWidth + 1)
  return { page: Math.max(root.scrollWidth, document.body.scrollWidth) > root.clientWidth, scrollRoots, escapes }
}

const browser = await chromium.launch()
let failures = 0
for (const width of WIDTHS) {
  const context = await browser.newContext({ viewport: { width, height: 800 } })
  await context.addCookies(cookies)
  const page = await context.newPage()
  for (const path of PAGES) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => undefined)
    const result = await page.evaluate(measure)
    if (result.page || result.scrollRoots || result.escapes.length > 0) {
      failures += 1
      console.log(`OVERFLOW ${width}px ${path}`, JSON.stringify(result))
    }
  }
  await context.close()
}
await browser.close()
console.log(failures === 0 ? `No overflow at ${WIDTHS.join(', ')}px.` : `${failures} page(s) overflow.`)
process.exit(failures === 0 ? 0 : 1)

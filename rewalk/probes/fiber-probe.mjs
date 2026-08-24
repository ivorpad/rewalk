// Probe (A2, throwaway): replay ledger-01's selectors against the running
// ledger dev app and record what a __reactFiber$ walk can actually name.
// Records EVERYTHING the walk sees (client component names, React 19 dev
// _debugInfo server-component names, owner chain) so the filter is designed
// from measurement, not assumption.
//   node probes/fiber-probe.mjs <appUrl> <sessionDir> <outFile>
import fs from 'node:fs'
import path from 'node:path'
import { loadChromium } from '../lib/engine.mjs'
const chromium = await loadChromium()

const [URL_, DIR, OUT] = process.argv.slice(2)
const resolved = JSON.parse(fs.readFileSync(path.join(DIR, 'resolved.json'), 'utf8'))

const sels = new Set()
for (const u of resolved) {
  for (const d of (u.deltas ?? []).slice(0, 3)) sels.add(d.node)
  for (const i of (u.interactions ?? [])) if (i.s) sels.add(i.s)
  if (u.pointedAt) for (const s of u.pointedAt.split(' ; ')) sels.add(s)
  for (const h of (u.held ?? []).slice(0, 3)) sels.add(h.node)
}

// rewalk's nameOf() emits `x/text()` for text nodes — probe the parent element.
const cssOf = (s) => s.replace(/\/text\(\)$/, '')

const WALK = `(el) => {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  if (!key) return { fiber: false }
  const out = { fiber: true, chain: [] }
  let f = el[key], hops = 0
  while (f && hops < 60) {
    const t = f.type
    let name = null
    if (typeof t === 'function') name = t.displayName || t.name || null
    else if (t && typeof t === 'object') name = t.displayName || null
    else if (typeof t === 'string') name = '<' + t + '>'
    const dbg = (f._debugInfo ?? []).map((d) => d.name).filter(Boolean)
    if (name || dbg.length) out.chain.push({ name, dbg })
    f = f.return; hops++
  }
  return out
}`

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(URL_ + '/login')
await page.fill('input[name=email]', 'ivor@ledger.local')
await page.fill('input[name=password]', 'ledger')
await page.click('form:has(input[name=password]) button[type=submit]')
await page.waitForURL((u) => !u.pathname.includes('login'))

const results = {}
for (const route of ['/transactions', '/accounts']) {
  await page.goto(URL_ + route)
  await page.waitForLoadState('networkidle')
  for (const sel of sels) {
    if (results[sel]?.found) continue
    let r
    try {
      const el = await page.$(cssOf(sel))
      if (!el) { r = results[sel] ?? { found: false } }
      else r = { found: true, page: route, ...(await el.evaluate(eval(WALK))) }
    } catch (e) { r = { found: false, error: e.message.slice(0, 120) } }
    results[sel] = r
  }
}
await browser.close()
fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
const found = Object.values(results).filter((r) => r.found)
console.log(`${Object.keys(results).length} selectors, ${found.length} found on a live page, ${found.filter((r) => r.fiber).length} with a fiber key`)
for (const [sel, r] of Object.entries(results)) {
  if (!r.found) { console.log(`MISS  ${sel.slice(0, 70)}  ${r.error ?? ''}`); continue }
  const named = (r.chain ?? []).filter((c) => (c.name && !c.name.startsWith('<')) || c.dbg.length)
  console.log(`HIT   ${sel.slice(0, 70)}`)
  console.log(`      ${named.slice(0, 6).map((c) => (c.name ?? '') + (c.dbg.length ? ` [dbg:${c.dbg.join(',')}]` : '')).join(' -> ') || '(no named components in walk)'}`)
}

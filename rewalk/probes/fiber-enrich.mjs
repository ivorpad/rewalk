// Probe (A2, throwaway): replay ledger-01's marks and rect targets against the
// running ledger dev app, walk __reactFiber$ + React 19 dev _debugInfo, and
// patch the nearest named component into a COPY of the session
// (out/ledger-a2/resolved.json). The copy is what `locate` runs on for the
// selector+component condition; ledger-01 itself is never touched.
//
// Page attribution comes from the session timeline: the recording soft-navigated
// from /transactions to /accounts at the first sidebar-nav click (no rrweb Meta
// event fires on soft nav), so items before that click replay against
// /transactions states and items after it against /accounts states.
//
// The loading skeletons only exist during a suspense window, so the probe
// delays the RSC fetch during a soft navigation and queries the pulse nodes
// inside the delay — that is the state the recorder actually saw.
//
//   node probes/fiber-enrich.mjs http://localhost:3100 out/ledger-01 out/ledger-a2
import fs from 'node:fs'
import path from 'node:path'
import { loadChromium } from '../lib/engine.mjs'
const chromium = await loadChromium()

const [URL_, SRC, DST] = process.argv.slice(2)
const resolved = JSON.parse(fs.readFileSync(path.join(SRC, 'resolved.json'), 'utf8'))

// The recorded name `#\[object\ HTMLInputElement\]` is a capture artifact (a
// form whose field is named "id" makes el.id an element, not a string — see
// the platform-facts note). It cannot be replayed literally; it IS the drawer
// form. Alias only for replay purposes; a live capture never needs this.
const ALIAS = { '#\\[object\\ HTMLInputElement\\]': 'aside.fixed form' }
const cssOf = (s) => {
  let out = s.replace(/\/text\(\)$/, '')
  for (const [k, v] of Object.entries(ALIAS)) out = out.split(k).join(v)
  return out
}

const WALK = `(el) => {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
  if (!key) return { fiber: false }
  const DENY = /^__next|Boundary$|Context$|Provider$|^(LinkComponent|InnerLayoutRouter|OuterLayoutRouter|SegmentViewNode|RenderFromTemplateContext|ScrollAndFocusHandler|HotReload|Router|AppRouter|Head)$/
  const chain = []
  let f = el[key], hops = 0
  while (f && hops < 60) {
    const names = (f._debugInfo ?? []).map((d) => d.name).filter(Boolean)
    const t = f.type
    if (typeof t === 'function' && (t.displayName || t.name)) names.push(t.displayName || t.name)
    else if (t && typeof t === 'object' && t.displayName) names.push(t.displayName)
    for (const n of names) if (!DENY.test(n) && n.length >= 4 && !chain.includes(n)) chain.push(n)
    f = f.return; hops++
  }
  return { fiber: true, chain }
}`

// Selectors, split by which side of the nav click each item sits on.
const marks = resolved.flatMap((u) => u.interactions ?? [])
const navClick = marks.find((m) => /aside\.hidden\.w-52 > nav/.test(m.s ?? ''))
if (!navClick) { console.error('no sidebar nav click found — cannot attribute pages'); process.exit(2) }
const T_NAV = navClick.at
console.log(`nav click at ${T_NAV} — items before replay on /transactions, after on /accounts`)

const need = { pre: new Set(), post: new Set() }
for (const u of resolved) {
  for (const d of (u.deltas ?? []).slice(0, 3)) {
    if (d.kind !== 'rect' && d.kind !== 'motion') continue      // marks and rect targets only
    need[d.at < T_NAV ? 'pre' : 'post'].add(d.node)
  }
  for (const i of (u.interactions ?? [])) if (i.s) need[i.at < T_NAV ? 'pre' : 'post'].add(i.s)
}

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto(URL_ + '/login')
await page.fill('input[name=email]', 'ivor@ledger.local')
await page.fill('input[name=password]', 'ledger')
await page.click('form:has(input[name=password]) button[type=submit]')
await page.waitForURL((u) => !u.pathname.includes('login'))

const probe = async (sel) => {
  try {
    const el = await page.$(cssOf(sel))
    if (!el) return null
    const r = await el.evaluate(eval(WALK))
    return r.fiber ? r.chain : []
  } catch { return null }
}

const states = {}   // state -> selector -> chain
const tryAll = async (state, sels) => {
  states[state] ??= {}
  for (const sel of sels) {
    if (states[state][sel]) continue
    const chain = await probe(sel)
    if (chain?.length) states[state][sel] = chain
  }
}

// -- /transactions loaded ----------------------------------------------------
await page.goto(URL_ + '/transactions')
await page.waitForLoadState('networkidle')
await tryAll('transactions', need.pre)

// -- drawer open ---------------------------------------------------------
const href = await page.getAttribute('tbody tr[data-href]', 'data-href')
if (href) {
  await page.goto(URL_ + '/transactions' + href)
  await page.waitForLoadState('networkidle')
  await tryAll('drawer', need.pre)
} else console.log('no data-href row — drawer state skipped')

// -- loading skeletons -------------------------------------------------------
// Soft nav in Next 16 keeps the OLD screen during the transition, so
// loading.tsx never appears that way. The recording saw the skeletons on
// streamed FULL loads (SSR sends the loading fallback first, the page chunk
// after). Replicate: throttle the network so the stream trickles, and walk
// the pulse nodes while only the fallback has arrived.
const cdp = await page.context().newCDPSession(page)
const probeLoading = async (state, route, sels) => {
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions',
    { offline: false, latency: 100, downloadThroughput: 24 * 1024, uploadThroughput: 256 * 1024 })
  await page.goto(URL_ + route, { waitUntil: 'commit' })
  const t0 = Date.now()
  while (Date.now() - t0 < 8000) {
    await tryAll(state, sels)
    if ([...sels].every((s) => states[state][s])) break
    await new Promise((r) => setTimeout(r, 30))
  }
  await cdp.send('Network.emulateNetworkConditions',
    { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await page.waitForLoadState('networkidle')
  console.log(`  [${state}] found ${Object.keys(states[state] ?? {}).length}/${[...sels].length}, url now: ${page.url()}`)
}
await probeLoading('tx-loading', '/transactions', new Set([...need.pre].filter((s) => /animate-pulse/.test(s))))
await page.goto(URL_ + '/accounts')
await page.waitForLoadState('networkidle')
await tryAll('accounts', need.post)
await probeLoading('ac-loading', '/accounts', new Set([...need.post].filter((s) => /animate-pulse/.test(s))))
await browser.close()

// -- patch the copy ----------------------------------------------------------
const lookup = (sel, at) => {
  const order = at < T_NAV ? ['transactions', 'drawer', 'tx-loading'] : ['accounts', 'ac-loading']
  for (const st of order) if (states[st]?.[sel]) return { component: states[st][sel][0], state: st }
  return null
}
let enriched = 0, missed = []
for (const u of resolved) {
  for (const d of (u.deltas ?? []).slice(0, 3)) {
    if (d.kind !== 'rect' && d.kind !== 'motion') continue
    const hit = lookup(d.node, d.at)
    if (hit) { d.component = hit.component; enriched++ } else missed.push(d.node)
  }
  for (const i of (u.interactions ?? [])) {
    if (!i.s) continue
    const hit = lookup(i.s, i.at)
    if (hit) { i.component = hit.component; enriched++ } else missed.push(i.s)
  }
}
fs.mkdirSync(DST, { recursive: true })
fs.writeFileSync(path.join(DST, 'resolved.json'), JSON.stringify(resolved, null, 1))
fs.writeFileSync(path.join(DST, 'fiber-states.json'), JSON.stringify(states, null, 1))
console.log(`\n${enriched} items enriched -> ${DST}/resolved.json`)
if (missed.length) console.log(`unprobeable (recorded honestly): ${[...new Set(missed)].join(' | ')}`)
for (const [st, m] of Object.entries(states))
  for (const [sel, chain] of Object.entries(m))
    console.log(`  [${st}] ${sel.slice(0, 60)} -> ${chain.slice(0, 3).join(' > ')}`)

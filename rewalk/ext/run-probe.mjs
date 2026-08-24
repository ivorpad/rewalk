// Load the built Plasmo extension into Chromium via the repo's own Playwright
// and answer three questions:
//   A. naive: navigate immediately after launch, then reload 4x — does the
//      dynamically-registered MAIN/document_start script beat the page's
//      first inline script every time?
//   B. mitigated: await chrome.scripting.getRegisteredContentScripts() in the
//      extension SW before the first navigation — does reload 1 stop missing?
//   C. baseline: the SAME compiled bundles injected via addInitScript in a
//      plain Playwright context — what does today's route capture on this
//      fixture, so A/B are compared against measurement, not memory.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(HERE, 'build', 'chrome-mv3-prod')
const PORT = 51944
const RELOADS = 5

const { chromium } = await import(
  path.join(HERE, '..', 'skill', 'node_modules', 'playwright', 'index.mjs')
)

// Tiny static server for the scratch fixture. file:// is out for the same
// reason as lib/serve.mjs: rrweb reads document.styleSheets.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' }
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '')
  const file = path.resolve(HERE, 'fixture', rel || 'probe.html')
  if (!file.startsWith(path.resolve(HERE, 'fixture'))) return res.writeHead(403).end('no')
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end('not found')
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store' })
    res.end(buf)
  })
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

async function measure(page, reload, phase) {
  await page.waitForFunction(() => window.__mutationsDone === true, null, { timeout: 10000 })
  const top = await page.evaluate(() => ({
    pageSaw: window.__pageSaw,
    probeAt: window.__probeAt ?? null,
    rrBootAt: window.__rrBootAt ?? null,
    rrRecordAt: window.__rrRecordAt ?? null,
    eventCount: (window.__rrExtBuf ?? []).length,
    eventsJson: JSON.stringify(window.__rrExtBuf ?? [])
  }))
  const child = page.frames().find((f) => f.url().includes('child.html'))
  const childSaw = child ? await child.evaluate(() => window.__pageSaw ?? null) : null
  const events = JSON.parse(top.eventsJson)
  const raw = top.eventsJson
  fs.writeFileSync(path.join(HERE, `events-${phase}-reload${reload}.json`), top.eventsJson)
  return {
    reload,
    topOrdering: {
      probeAtExisted: top.pageSaw?.probeAtExisted ?? false,
      attachShadowPatched: top.pageSaw?.attachShadowPatched ?? false,
      rrBundlePresent: top.pageSaw?.rrBundlePresent ?? false,
      probeT: top.probeAt?.t ?? null,
      probeReadyState: top.probeAt?.readyState ?? null,
      pageFirstScriptT: top.pageSaw?.t ?? null,
      rrBootT: top.rrBootAt?.t ?? null,
      rrRecordT: top.rrRecordAt?.t ?? null,
      rrRecordReadyState: top.rrRecordAt?.readyState ?? null
    },
    childOrdering: childSaw,
    analysis: {
      eventCount: top.eventCount,
      hasFullSnapshot: events.some((e) => e.type === 2),
      // IncrementalSource: Mutation=0, Input=5, StyleSheetRule=8
      cssomExistingSheetCaptured:
        events.some((e) => e.type === 3 && e.data?.source === 8 && (e.data.adds ?? []).length) &&
        raw.includes('probe-inserted-rule'),
      cssomFreshSheetCaptured: raw.includes('probe-fresh-rule'),
      shadowContentCaptured:
        raw.includes('shadow-probe-text') &&
        events.some((e) => e.type === 3 && e.data?.source === 0 && (e.data.adds ?? []).length),
      shadowGrabbedRefCaptured: raw.includes('shadow-grabbed-text'),
      inputValueCaptured:
        events.some((e) => e.type === 3 && e.data?.source === 5 &&
          e.data.text === 'js-set-value-123')
    }
  }
}

const URL_ = `http://127.0.0.1:${PORT}/probe.html`

async function extensionPhase(phase, { awaitRegistration }) {
  const profile = path.join(HERE, `.probe-profile-${phase}`)
  fs.rmSync(profile, { recursive: true, force: true })
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`]
  })
  const runs = []
  try {
    if (awaitRegistration) {
      // The pattern a real session start would use: do not navigate until the
      // SW confirms both scripts are registered.
      let sw = ctx.serviceWorkers()[0]
      if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 })
      const t0 = Date.now()
      for (;;) {
        const n = await sw.evaluate(() =>
          chrome.scripting.getRegisteredContentScripts().then((s) => s.length))
        if (n >= 2) break
        if (Date.now() - t0 > 10000) throw new Error('registration never completed')
        await new Promise((r) => setTimeout(r, 50))
      }
      runs.push({ registrationWaitMs: Date.now() - t0 })
    }
    const page = ctx.pages()[0] ?? await ctx.newPage()
    for (let i = 0; i < RELOADS; i++) {
      await page.goto(URL_, { waitUntil: 'load' })
      const r = await measure(page, i + 1, phase)
      runs.push(r)
      console.log(`[${phase}] reload ${i + 1}:`, JSON.stringify(r.analysis))
    }
  } finally {
    await ctx.close().catch(() => {})
  }
  return runs
}

async function baselinePhase() {
  // Same compiled files, Playwright's own injection. addInitScript = the
  // guarantee the extension route is being measured against.
  const probeJs = fs.readdirSync(DIST).find((f) => f.startsWith('probe.'))
  const recorderJs = fs.readdirSync(DIST).find((f) => f.startsWith('recorder.'))
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext()
  await ctx.addInitScript({ path: path.join(DIST, probeJs) })
  await ctx.addInitScript({ path: path.join(DIST, recorderJs) })
  const runs = []
  try {
    const page = await ctx.newPage()
    for (let i = 0; i < RELOADS; i++) {
      await page.goto(URL_, { waitUntil: 'load' })
      const r = await measure(page, i + 1, 'baseline')
      runs.push(r)
      console.log(`[baseline] reload ${i + 1}:`, JSON.stringify(r.analysis))
    }
  } finally {
    await browser.close().catch(() => {})
  }
  return runs
}

const results = {
  naive: await extensionPhase('naive', { awaitRegistration: false }),
  mitigated: await extensionPhase('mitigated', { awaitRegistration: true }),
  baseline: await baselinePhase()
}
server.close()
fs.writeFileSync(path.join(HERE, 'probe-runs.json'), JSON.stringify(results, null, 2))

for (const [phase, allRuns] of Object.entries(results)) {
  const runs = allRuns.filter((r) => r.reload)
  const ok = (f) => runs.every(f) ? `PASS (${runs.length}/${runs.length})` : `FAIL: ` +
    runs.filter((r) => !f(r)).map((r) => `reload ${r.reload}`).join(', ')
  console.log(`\n=== ${phase} ===`)
  const wait = allRuns.find((r) => r.registrationWaitMs !== undefined)
  if (wait) console.log('registration wait ms:', wait.registrationWaitMs)
  console.log('probe before page first script:', ok((r) => r.topOrdering.probeAtExisted))
  console.log('attachShadow patched before page:', ok((r) => r.topOrdering.attachShadowPatched))
  console.log('rrweb bundle evaluated before page:', ok((r) => r.topOrdering.rrBundlePresent))
  console.log('iframe saw probe:', ok((r) => r.childOrdering?.probeAtExisted === true))
  console.log('cssom insertRule (existing sheet):', ok((r) => r.analysis.cssomExistingSheetCaptured))
  console.log('cssom insertRule (same-tick fresh sheet):', ok((r) => r.analysis.cssomFreshSheetCaptured))
  console.log('shadow content (normal call):', ok((r) => r.analysis.shadowContentCaptured))
  console.log('shadow content (pre-grab bypass):', ok((r) => r.analysis.shadowGrabbedRefCaptured))
  console.log('js-set input value captured:', ok((r) => r.analysis.inputValueCaptured))
}

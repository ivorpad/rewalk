// Human-driven session recorder. Same evidence artifacts as web-qa's qa.mjs
// (rrweb replay + Playwright trace + per-step network/console), except the
// steps come from a person clicking rather than from a CSV.
//
// Each interaction is logged with the app state at that instant — timeline
// counter, lens headline, highlighted line, scroll position — so the log reads
// back as "what the reader was looking at when they clicked", which is the
// thing worth explaining afterwards.
//
//   node record-session.mjs <url> [outDir]
//   touch <outDir>/STOP                          # or just close the window
//   node record-session.mjs --finalise [outDir]  # rebuild artifacts after a crash
//
// DURABILITY. Nothing that matters is held in memory until shutdown, because a
// recorder that buffers its output is one crash away from having recorded
// nothing. As they arrive:
//
//   replay/<flow>.ndjson   one rrweb event per line, appended every ~250ms
//   session.steps.json     rewritten after every interaction
//   session.meta.json      rewritten every second (url, viewport, t0, net, logs)
//
// Shutdown only *assembles*: finalise() reads those three files and writes
// run.json + replay/<flow>.json, the pair build-viewer.mjs consumes. It never
// reads a variable. So `kill -9` costs at most the last flush interval, and
// `--finalise` turns whatever is on disk into a playable recording — no
// browser, no Playwright, no live process required.

import fs from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

const SK = new URL('../skill', import.meta.url).pathname
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Streams ndjson -> a JSON array file. Chunked rather than
// JSON.stringify(bigArray) because that is its own way to lose a long session:
// V8 caps a single string at ~512MB and throws RangeError on the last line of
// the script, which is exactly when there is the most to lose.
// ---------------------------------------------------------------------------
function packEvents(ndjsonPath, jsonPath) {
  const outFd = fs.openSync(jsonPath, 'w')
  let events = 0, torn = 0
  const emit = (line) => {
    if (!line) return
    try { JSON.parse(line) } catch { torn++; return }  // a kill mid-write leaves a half line
    fs.writeSync(outFd, (events++ ? ',' : '') + line)
  }
  try {
    fs.writeSync(outFd, '[')
    if (fs.existsSync(ndjsonPath)) {
      const inFd = fs.openSync(ndjsonPath, 'r')
      const buf = Buffer.alloc(1 << 22)
      const dec = new StringDecoder('utf8')     // chunk borders can split a “ ”
      let rest = '', n
      try {
        while ((n = fs.readSync(inFd, buf, 0, buf.length, null)) > 0) {
          const parts = (rest + dec.write(buf.subarray(0, n))).split('\n')
          rest = parts.pop()
          for (const l of parts) emit(l)
        }
      } finally { fs.closeSync(inFd) }
      emit(rest + dec.end())
    }
    fs.writeSync(outFd, ']')
  } finally { fs.closeSync(outFd) }
  return { events, torn }
}

// ---------------------------------------------------------------------------
// finalise: disk -> disk, deliberately knowing nothing about Playwright, so it
// works on a session whose process is long dead. Idempotent: run it as often as
// you like, mid-session included.
// ---------------------------------------------------------------------------
function finalise(out) {
  const metaPath = `${out}/session.meta.json`
  if (!fs.existsSync(metaPath)) throw new Error(`no ${metaPath} — nothing to finalise`)
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  const flow = meta.flow
  const stepsPath = `${out}/session.steps.json`
  const steps = fs.existsSync(stepsPath) ? JSON.parse(fs.readFileSync(stepsPath, 'utf8')) : []
  const { events, torn } = packEvents(`${out}/replay/${flow}.ndjson`, `${out}/replay/${flow}.json`)
  const trace = fs.existsSync(`${out}/traces/${flow}.zip`) ? `traces/${flow}.zip` : undefined
  fs.writeFileSync(`${out}/run.json`, JSON.stringify({
    base: meta.base, viewport: meta.viewport, timeout: 0,
    flows: [{
      id: flow, trace, replay: `${flow}.json`, t0Epoch: meta.t0Epoch, duration: meta.duration,
      steps, net: meta.net ?? [], rrwebEvents: events,
    }],
  }, null, 1))
  return { events, torn, steps: steps.length, trace, flow }
}

const argv = process.argv.slice(2)
if (['--finalise', '--finalize', '--recover'].includes(argv[0])) {
  const out = argv[1] ?? 'session-out'
  const r = finalise(out)
  console.log(`finalised ${out}: ${r.events} rrweb events, ${r.steps} interactions` +
    `${r.torn ? `, ${r.torn} torn line(s) dropped` : ''}${r.trace ? '' : ', no trace'}`)
  console.log(`  OUT=${out} node ${SK}/scripts/build-viewer.mjs`)
  process.exit(0)
}

const URL_ = argv[0]
const OUT = argv[1] ?? 'session-out'
const FLOW = process.env.FLOW ?? 'session-1'
const MASK = process.env.MASK === '1'
const GROUND = process.env.GROUND ?? 'uxmapper screen composer'
const VW = +(process.env.VW ?? 1440), VH = +(process.env.VH ?? 900)
const TRACE_MS = +(process.env.TRACE_MS ?? 60000)

if (!URL_) { console.error('usage: node record-session.mjs <url> [outDir]  |  --finalise [outDir]'); process.exit(2) }
for (const d of ['traces', 'replay']) fs.mkdirSync(`${OUT}/${d}`, { recursive: true })

// Refuse to overwrite a recording that was never finalised — that is a crashed
// session waiting to be recovered, and it is the only copy.
const NDJSON = `${OUT}/replay/${FLOW}.ndjson`
if (fs.existsSync(NDJSON) && fs.statSync(NDJSON).size > 0 && process.env.FORCE !== '1') {
  const run = `${OUT}/run.json`
  const done = fs.existsSync(run) && fs.statSync(run).mtimeMs >= fs.statSync(NDJSON).mtimeMs
  if (!done) {
    console.error(`${NDJSON} holds an unfinalised recording.`)
    console.error(`  recover it:  node ${process.argv[1]} --finalise ${OUT}`)
    console.error(`  or discard:  FORCE=1 node ${process.argv[1]} ${URL_} ${OUT}`)
    process.exit(3)
  }
}
fs.rmSync(`${OUT}/STOP`, { force: true })
fs.rmSync(NDJSON, { force: true })
fs.rmSync(`${OUT}/run.json`, { force: true })   // a stale run.json must not outlive its events

const RRWEB = fs.readFileSync(`${SK}/node_modules/rrweb/dist/rrweb.umd.min.cjs`, 'utf8')
const RECORD = fs.readFileSync(`${SK}/scripts/rrweb-record.js`, 'utf8').replaceAll('__MASK__', JSON.stringify(MASK))

// Reads the app's own state at click time. Everything here is a DOM read of
// what is on screen — no app internals, so it survives viewer changes or
// degrades to nulls rather than throwing.
const PROBE = `(() => {
  try {
    const code = document.querySelector('[aria-label^="Source code"]');
    const lens = document.querySelector('[aria-label="Explanation lens"]');
    const rows = code ? [...code.querySelectorAll('[data-line]')] : [];
    const strong = rows.find(r => /79,\\s*209,\\s*197/.test(r.style.background || ''));
    const cr = code && code.getBoundingClientRect();
    const sr = strong && strong.getBoundingClientRect();
    const lr = lens && lens.getBoundingClientRect();
    const lt = lens ? lens.innerText.split('\\n') : [];
    return {
      counter: document.querySelector('[aria-label="Timeline position"]')?.textContent.trim() ?? null,
      frame: lt[1] ?? null,
      mode: lt.includes('Recorded values') ? 'values' : 'explain',
      headline: lt[6] ?? null,
      strongLine: strong ? Number(strong.dataset.line) : null,
      strongOnScreen: sr && cr ? sr.top >= cr.top && sr.bottom <= cr.bottom : null,
      lensTop: lr && cr ? Math.round(lr.top - cr.top) : null,
      lensHeight: lens ? Math.round(lr.height) : null,
      lensScrollHeight: lens ? lens.scrollHeight : null,
      cardToLine: lr && sr ? Math.round(lr.top - sr.top) : null,
      scrollTop: code ? Math.round(code.scrollTop) : null,
      viewportH: cr ? Math.round(cr.height) : null,
      idea: document.body.innerText.match(/Idea \\d+ of \\d+/)?.[0] ?? null,
    };
  } catch (e) { return { probeError: String(e) }; }
})()`

const LOGGER = `
(() => {
  if (window.__qaLog) return;
  window.__qaLog = 1;
  const describe = (el) => {
    if (!el || el === document.body) return 'page';
    const parts = [];
    const label = el.getAttribute?.('aria-label');
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    if (label) parts.push('[' + label + ']');
    else if (text) parts.push('"' + text + '"');
    else parts.push('<' + el.tagName.toLowerCase() + '>');
    const line = el.closest?.('[data-line]');
    if (line) parts.push('line ' + line.dataset.line);
    if (el.closest?.('[aria-label="Explanation lens"]')) parts.push('in lens');
    else if (el.closest?.('[role="dialog"]')) parts.push('in card');
    return parts.join(' · ');
  };
  const send = (kind, label) => {
    const state = ${PROBE};
    try { window.__qaStep?.({ kind, label }); } catch (e) {}
    try { window.__qaAction({ kind, label, state, href: location.href }); } catch (e) {}
  };
  addEventListener('click', (e) => {
    const t = e.target;
    const el = t.closest?.('button, a, [role="button"], [role="tab"], input, select, textarea, [data-line]') || t;
    // let the app's own handler run first, so the state we read is the result
    setTimeout(() => send('click', describe(el)), 400);
  }, true);
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length > 1 && !/^(Enter|Escape|Arrow|Tab| )/.test(e.key)) return;
    setTimeout(() => send('key', e.key), 400);
  }, true);
})();`

const steps = []
const net = []
const logs = []
const T0 = Date.now(), now = () => Date.now() - T0

const summarise = (s) =>
  !s || s.probeError ? (s?.probeError ?? '') :
  [s.counter && `${s.counter}`, s.headline && `“${s.headline}”`, s.strongLine && `line ${s.strongLine}`,
   s.strongOnScreen === false && 'OFF SCREEN', s.cardToLine != null && `card ${s.cardToLine > 0 ? '+' : ''}${s.cardToLine}px`,
   s.scrollTop != null && `scroll ${s.scrollTop}`].filter(Boolean).join(' · ')

// --- the three incremental sinks -------------------------------------------
const rrFd = fs.openSync(NDJSON, 'a')
let rrCount = 0
const appendEvents = (batch) => {
  if (!batch?.length) return
  try {
    fs.writeSync(rrFd, batch.map((e) => JSON.stringify(e)).join('\n') + '\n')
    rrCount += batch.length
  } catch (e) { console.error('rrweb append failed:', e.message) }
}
const writeLog = () => fs.writeFileSync(`${OUT}/session.steps.json`, JSON.stringify(steps, null, 1))
const writeMeta = () => fs.writeFileSync(`${OUT}/session.meta.json`, JSON.stringify({
  base: URL_, flow: FLOW, viewport: { w: VW, h: VH }, t0Epoch: T0, duration: now(),
  rrwebEvents: rrCount, net, logs,
}, null, 1))
writeMeta(); writeLog()

// Last-ditch salvage. Signals and uncaught throws still get a finalise; only
// kill -9 skips this, and that is what the ndjson on disk is for.
let salvaging = false
const salvage = (why) => {
  if (salvaging) return; salvaging = true
  try { writeMeta(); const r = finalise(OUT); console.error(`salvaged (${why}): ${r.events} rrweb events, ${r.steps} interactions -> ${OUT}/run.json`) }
  catch (e) { console.error(`salvage failed (${why}): ${e.message}`) }
}
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e?.stack ?? e); salvage('uncaughtException'); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', e?.stack ?? e); salvage('unhandledRejection'); process.exit(1) })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { salvage(sig); process.exit(130) })

const { chromium } = await import(`${SK}/node_modules/playwright/index.mjs`)
const browser = await chromium.launch({ headless: process.env.HEADLESS === '1', args: [`--window-size=${VW},${VH + 120}`] })
const ctx = await browser.newContext({ viewport: { width: VW, height: VH } })

await ctx.exposeBinding('__rrwebEmit', (_s, batch) => appendEvents(batch))
await ctx.exposeBinding('__qaAction', (_s, a) => {
  const since = steps[steps.length - 1]?.t_end ?? 0
  // invariant, same rule as qa.mjs: an interaction that "worked" still fails
  // the step if the page complained while it was happening
  const mine = logs.filter((l) => l.t >= since)
  steps.push({
    flow_id: FLOW,
    step: steps.length + 1,
    action: a.kind,
    target: a.label,
    expect: '',
    req: 'manual',
    status: mine.length ? 'FAIL' : 'pass',
    error: mine.length ? `invariant: ${mine[0].kind} ${mine[0].text}` : '',
    expected: '',
    actual: summarise(a.state),
    state: a.state,
    href: a.href,
    t_start: since,
    t_end: now(),
    logs: mine,
  })
  writeLog(); writeMeta()
})
await ctx.addInitScript(RRWEB + ';\n' + RECORD + '\n' + LOGGER)

await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false, title: FLOW })
const page = await ctx.newPage()

page.on('console', (m) => m.type() === 'error' && logs.push({ t: now(), kind: 'console', text: m.text() }))
page.on('pageerror', (e) => logs.push({ t: now(), kind: 'pageerror', text: e.message }))
page.on('requestfailed', (r) => logs.push({ t: now(), kind: 'requestfailed', text: `${r.method()} ${r.url()} ${r.failure()?.errorText}` }))
page.on('response', (r) => {
  net.push({ t: now(), method: r.request().method(), url: r.request().url(), status: r.status(), type: r.request().resourceType() })
  if (r.status() >= 400) logs.push({ t: now(), kind: 'http', text: `${r.status()} ${r.request().method()} ${r.request().url()}` })
})

await page.goto(URL_, { waitUntil: 'load' })

// §0 ground truth: prove this is the app under test before anything is recorded.
await page.waitForTimeout(3000)
const body = await page.evaluate(() => document.body.innerText.slice(0, 4000))
if (!body.includes(GROUND)) {
  console.error(`GROUND TRUTH FAILED: "${GROUND}" not on ${URL_}`)
  await browser.close().catch(() => {}); process.exit(2)
}
console.log(`recording ${URL_}  (ground truth "${GROUND}" ok)`)
console.log(`stop with: touch ${OUT}/STOP   — or close the window`)
console.log(`if this process dies: node ${process.argv[1]} --finalise ${OUT}`)

if (process.env.SMOKE === '1') {
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.includes('Let the model read the design system'))
    chip?.click()
  })
  await page.waitForTimeout(2500)
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === 'Values')?.click())
  await page.waitForTimeout(2500)
  await page.evaluate(() => document.querySelector('[aria-label="Next recorded moment"]')?.click())
  await page.waitForTimeout(2500)
  fs.writeFileSync(`${OUT}/STOP`, '')
}

let stopped = false, why = ''
const markStopped = (r) => () => { if (!stopped) { stopped = true; why = r } }
browser.on('disconnected', markStopped('browser closed'))
ctx.on('close', markStopped('context closed'))
page.on('close', markStopped('page closed'))

while (!stopped && !fs.existsSync(`${OUT}/STOP`)) { await sleep(1000); writeMeta() }
if (!stopped) why = 'STOP file'

// Shutdown is best-effort from here down. The window may already be gone — that
// is the normal way a human ends a session — so every call that touches it is
// individually guarded, and none of them gate the artifacts.
console.log(`\nstopping (${why}) …`)
await page.evaluate(() => window.__rrFlush?.()).catch(() => {})
await sleep(500)   // a node timer, not page.waitForTimeout: that one throws
                   // "Target page, context or browser has been closed" once the
                   // window is shut, which is what killed the 24-step session.
writeMeta()

let r = finalise(OUT)
console.log(`${r.steps} interactions, ${r.events} rrweb events, ${logs.length} page complaints -> ${OUT}/run.json`)

// The trace is the slow, failure-prone artifact — minutes on a long session,
// and it throws outright if the browser is already gone. It is stopped after
// the recording is safe and under a hard timeout, so it can only cost itself.
const bounded = (p, ms, what) => Promise.race([
  Promise.resolve(p).catch((e) => console.error(`${what}: ${e.message.split('\n')[0]}`)),
  sleep(ms).then(() => console.error(`${what}: timed out after ${ms}ms — skipped`)),
])
await bounded(ctx.tracing.stop({ path: `${OUT}/traces/${FLOW}.zip` }), TRACE_MS, 'tracing.stop')
await bounded(browser.close(), 15000, 'browser.close')
if (fs.existsSync(`${OUT}/traces/${FLOW}.zip`)) r = finalise(OUT)   // now run.json can point at it

fs.closeSync(rrFd)
console.log(`  trace: ${r.trace ?? 'none'}\n  build: OUT=${OUT} node ${SK}/scripts/build-viewer.mjs`)
process.exit(0)

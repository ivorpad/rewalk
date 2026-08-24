// Record a session against the labelled fixture, then resolve every utterance
// and score it against the answer we know by construction.
//
// The utterances here carry real narration lag (each is stamped 1.4-2.6s AFTER
// the interaction it describes, which is where people actually speak) but they
// are typed, not spoken. The audio path is measured separately; what is under
// test here is the join.

import fs from 'node:fs'
import path from 'node:path'
import { loadChromium } from '../lib/engine.mjs'
const chromium = await loadChromium()
import { bootScript, Sink } from '../lib/record.mjs'
import { readStream, buildMirror, extractDeltas, extractMarks, extractObserved } from '../lib/deltas.mjs'
import { churnProfile, resolveUtterance, ambientSuppression, fitClock } from '../lib/resolve.mjs'
import { ensureFixtureServer } from '../lib/serve.mjs'

const server = await ensureFixtureServer()
const URL_ = process.argv[2] ?? server.url('lab.html')
const OUT = process.argv[3] ?? 'out/lab'
fs.rmSync(OUT, { recursive: true, force: true })
const sink = new Sink(OUT)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
// The crash fix: every batch hits the disk as it arrives. Nothing is buffered
// for a final write, so a kill at any moment costs at most the last 250ms.
await ctx.exposeBinding('__rewalkEmit', (_s, batch) => sink.push(batch))
await ctx.addInitScript(bootScript({ mask: false }))
const page = await ctx.newPage()
await page.goto(URL_, { waitUntil: 'load' })
await page.waitForTimeout(1200)

// The fixture cycles and starts on step 0, so click n applies step n+1. Getting
// this wrong is how the first run "failed": the resolver was right and the
// labels were not. Ground truth, per click, read straight off fixtures/lab.html:
//   click 0 -> step 1  line 96,  left 964 (unchanged), body short
//   click 1 -> step 2  line 188, left 964 -> 811                <- the move
//   click 2 -> step 3  line 260, body short -> long             <- the growth
//   click 3 -> step 4  line 331, body long -> short
//   click 4 -> step 0  line 12,  left 811 -> 964
const CLICKS = 5
const SAID = [
  { after: 1, lag: 1800, text: 'the card is going to the left',
    want: { node: '#lens', prop: /left|rect\.x/ }, why: 'inline style.left 964 -> 811' },
  { after: 2, lag: 2200, text: 'the card got a lot taller there',
    want: { node: '#lens', prop: /height/ }, why: 'layout-derived: no attribute ever says so' },
  { after: 3, lag: 1400, point: true, text: 'the highlighted line does not scroll into view, it just stays put',
    want: { node: '#code', prop: /scrollTop/, held: true }, why: 'stasis: scrollTop never moves all session' },
  { after: 3, lag: 2600, text: 'that purple bar keeps sliding around',
    want: { node: '#ghost', prop: /motion|left|rect\.x|transition/ }, why: 'geometric CSS transition, 220ms' },
  { after: 4, lag: 1900, text: 'the teal one lingers when it fades out',
    want: { node: '#fade', prop: /motion|transition|opacity/ }, why: 'opacity-only transition: no rect ever moves' },
]

const clicks = []
for (let i = 0; i < CLICKS; i++) {
  await page.click('#next')
  clicks.push(Date.now())
  await page.waitForTimeout(1500)
  // push-to-talk: alt-click the thing you are about to complain about
  if (SAID.some((u) => u.after === i && u.point)) {
    // NOT page.click(): Playwright scrolls the target into view first, which
    // scrolls #code and erases the stasis this utterance is about. Measuring
    // something must not cause the thing being measured.
    await page.evaluate(() => {
      const el = document.querySelector('.ln.hot')
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
    })
  }
  await page.waitForTimeout(1400)
}

await page.evaluate(() => window.__rrFlush?.())
await page.waitForTimeout(600)
sink.meta({ url: URL_, startedWall: clicks[0], clicks })
await browser.close()
sink.close()

// ---- resolve -------------------------------------------------------------
const events = readStream(fs.readFileSync(path.join(OUT, 'events.ndjson'), 'utf8'))
const mirror = buildMirror(events)
const deltas = extractDeltas(events, mirror)
const { marks, clocks } = extractMarks(events)
const observed = extractObserved(events)
const churn = churnProfile(deltas, marks, observed)
const ambient = ambientSuppression(deltas)
const clock = fitClock(clocks)

const utterances = SAID.map((u) => ({ ...u, at: clicks[u.after] + u.lag }))

console.log(`stream      ${events.length} rrweb events, ${deltas.length} deltas, ${marks.length} marks`)
console.log(`observable  ${observed.size} node+prop pairs never required to change`)
console.log(`clock       ${clock.n} pairs, drift ${clock.driftPpm} ppm, residual ${clock.residualMs} ms`)
const mw = events.filter((e) => e.type === 5 && e.data.tag === 'rewalk-motion-window')
console.log(`motion      ${mw.length} windows; ${events.filter((e) => e.type === 5 && e.data.tag === 'rewalk-motion').length} transition lifecycle events`)
console.log()

let hits = 0
const report = []
for (const u of utterances) {
  const r = resolveUtterance(u, { deltas, marks, churn, ambient })
  const list = u.want.held ? r.held : r.deltas
  const rank = list.findIndex((d) => d.node === u.want.node && u.want.prop.test(d.prop))
  const top = list[0]
  if (rank === 0) hits++
  report.push({ ...r, rank, want: u.want, why: u.why })
  console.log(`"${u.text}"`)
  console.log(`   query   ${r.query}${r.pointedAt ? '  pointed at ' + r.pointedAt : ''}`)
  console.log(`   want    ${u.want.node} ${u.want.prop}   (${u.why})`)
  console.log(`   got     ${top ? `${top.node} ${top.prop}` : '(nothing)'}` +
    (top && top.from != null ? `  ${top.from} -> ${top.to}` : '') +
    `   rank of correct answer: ${rank < 0 ? 'NOT IN TOP ' + list.length : rank + 1}`)
  for (const d of list.slice(0, 4))
    console.log(`     ${String(d.score).padStart(6)}  ${d.node} ${d.prop}` +
      (d.from != null ? `  ${d.from} -> ${d.to}` : '') +
      (d.parts ? `   [${Object.entries(d.parts).filter(([, v]) => v).map(([k, v]) => k + ' ' + v).join(', ')}]` : '') +
      (d.changedInSteps !== undefined ? `   changed in ${d.changedInSteps}/${d.ofSteps} steps` : ''))
  console.log()
}
fs.writeFileSync(path.join(OUT, 'resolved.json'), JSON.stringify(report, null, 1))
console.log(`top-1 accuracy  ${hits}/${utterances.length}`)

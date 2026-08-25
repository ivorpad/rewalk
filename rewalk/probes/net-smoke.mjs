// Probe (throwaway): does the net.js instrument put requests, responses and
// page errors into the stream, and do they ride a complaint's window?
//   node probes/net-smoke.mjs http://localhost:3100
import fs from 'node:fs'
import { loadChromium } from '../lib/engine.mjs'
import { bootScript, Sink } from '../lib/record.mjs'
import { readStream, extractNet, extractConsole, buildMirror, extractDeltas, extractMarks } from '../lib/deltas.mjs'
import { churnProfile, resolveUtterance } from '../lib/resolve.mjs'
const chromium = await loadChromium()

const URL_ = process.argv[2]
const OUT = 'out/net-smoke'
fs.rmSync(OUT, { recursive: true, force: true })
const sink = new Sink(OUT)
const browser = await chromium.launch()
const ctx = await browser.newContext()
await ctx.exposeBinding('__rewalkEmit', (_s, batch) => sink.push(batch))
await ctx.addInitScript(bootScript({ mask: true }))
const page = await ctx.newPage()
await page.goto(URL_ + '/login', { waitUntil: 'load' })
await page.evaluate(async () => {
  await fetch('/api/nonexistent')                      // 404 with a body
  await fetch('/login')                                // 200
  console.error('smoke: a console error')
  Promise.reject(new Error('smoke: an unhandled rejection'))
  await new Promise((r) => setTimeout(r, 300))
})
const tSpoke = Date.now()
await page.evaluate(() => new Promise((r) => setTimeout(r, 400)))
await page.evaluate(() => window.__rrFlush?.())
await new Promise((r) => setTimeout(r, 300))
await browser.close()
sink.close()

const events = readStream(fs.readFileSync(OUT + '/events.ndjson', 'utf8'))
const net = extractNet(events), con = extractConsole(events)
console.log('NET:', JSON.stringify(net, null, 1))
console.log('CONSOLE:', JSON.stringify(con, null, 1))

const mirror = buildMirror(events)
const deltas = extractDeltas(events, mirror)
const { marks } = extractMarks(events)
const churn = churnProfile(deltas, marks)
const r = resolveUtterance({ text: 'when I click this nothing happens at all', at: tSpoke },
  { deltas, marks, churn, net, consoleEvents: con })
console.log('WINDOW network:', (r.network ?? []).map((n) => `${n.method} ${n.url} ${n.status}${n.body ? ' body:' + n.body.slice(0, 40) : ''}`))
console.log('WINDOW console:', (r.console ?? []).map((c) => `${c.level}: ${c.text.slice(0, 50)}`))

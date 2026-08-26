// rewalk watch — record a human using a page, with their voice.
//
// Runs until <out>/STOP appears. Everything is written as it arrives: the rrweb
// stream appends to NDJSON, the mic bundle writes the wav continuously. There is no
// write-at-exit path, so killing this at any moment leaves a usable recording.
//
//   node bin/watch.mjs [url] [outDir]
//   touch <outDir>/STOP     # to finish
//
// Then: node bin/read.mjs <outDir>

import fs from 'node:fs'
import path from 'node:path'
import { loadChromium } from '../lib/engine.mjs'
import { bootScript, Sink, fitProgressClock } from '../lib/record.mjs'
import { BundleMic, bundleAvailable } from '../lib/mac/bundle-mic.mjs'
import { ensureFixtureServer } from '../lib/serve.mjs'

const chromium = await loadChromium()
const server = await ensureFixtureServer()
const URL_ = process.argv[2] ?? server.url('lab.html')
const OUT = process.argv[3] ?? 'out/session'
fs.rmSync(OUT, { recursive: true, force: true })
const sink = new Sink(OUT)

// Whichever microphone the person selected, and keep up if they change it.
const micEvents = []
let mic
try {
  if (!bundleAvailable()) throw new Error('rewalk-mic.app is not built — see lib/mac/rewalk-mic-src/README.md')
  mic = await new BundleMic(OUT, { onEvent: (e) => { micEvents.push(e); console.log(`[mic] ${e.kind} ${e.device ?? e.to ?? e.reason ?? ''}${e.dynamicRange ? ` (dynamic range ${e.dynamicRange}x)` : ''}`) } }).startAsync({ audition: process.env.REWALK_SKIP_AUDITION !== '1' })
} catch (e) {
  console.error(`\nREFUSING TO RECORD: ${e.message}`)
  if (e.stats) console.error(`  ${JSON.stringify(e.stats)}`)
  console.error(`  Fix it and run again, or set REWALK_SKIP_AUDITION=1 to record anyway.`)
  process.exit(3)
}

const browser = await chromium.launch({
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1360,900'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await ctx.exposeBinding('__rewalkEmit', (_s, batch) => sink.push(batch))
// Mask input values by default. rrweb records keystrokes, so an unmasked
// recording of a real site captures whatever you type into a login form in
// plaintext, into a file that then gets transcribed, packed into a replay and
// shared. That was acceptable while the only target was a fixture with no
// inputs; it is not acceptable the moment this points at a real website.
// REWALK_UNMASK=1 when you actually need the typed values.
const unmask = process.env.REWALK_UNMASK === '1'
if (unmask) console.log('[rec] REWALK_UNMASK=1 — input values WILL be recorded in the clear')
await ctx.addInitScript(bootScript({ mask: !unmask, beacon: process.env.REWALK_BEACON === '1', hud: true }))
const page = await ctx.newPage()
await page.goto(URL_, { waitUntil: 'load' })

const t0 = Date.now()
sink.meta({ url: URL_, browserReadyWall: t0, mic: mic.manifest() })
console.log(`recording -> ${OUT}`)
console.log(`stop with: touch ${OUT}/STOP`)

// Feed the HUD from the bytes the capturer has already written. Reading the tail of
// the growing wav is what makes the meter honest: it can only show a level the
// recording itself contains, so a dead device, a revoked permission or a
// mid-session unplug all go visibly red instead of being discovered at
// transcription time. (Both of those failure modes are real; both happened.)
const levelOf = () => {
  try {
    const seg = mic.segments[mic.segments.length - 1]
    if (!seg || seg.endedWall) return 0
    const size = fs.statSync(seg.file).size
    const want = 8000                            // 0.25s of 16k mono s16le
    if (size < 44 + want) return 0
    const fd = fs.openSync(seg.file, 'r')
    const buf = Buffer.alloc(want)
    fs.readSync(fd, buf, 0, want, size - want - (size % 2))
    fs.closeSync(fd)
    let sum = 0
    for (let i = 0; i + 1 < want; i += 2) { const v = buf.readInt16LE(i) / 32768; sum += v * v }
    return Math.sqrt(sum / (want / 2))
  } catch (e) { return 0 }
}

let stopped = false
browser.on('disconnected', () => { stopped = true })
const hudTimer = setInterval(() => {
  const rms = levelOf()
  page.evaluate((v) => window.__rewalkHudLevel?.(v), rms).catch(() => {})
}, 300)
while (!stopped && !fs.existsSync(path.join(OUT, 'STOP'))) {
  await new Promise((r) => setTimeout(r, 500))
}
clearInterval(hudTimer)

// Finalise what is already on disk rather than write what is held in memory.
// The prototype this replaces hung here with the whole stream unwritten.
try { await page.evaluate(() => window.__rrFlush?.()) } catch (e) {}
await new Promise((r) => setTimeout(r, 400))
try { await browser.close() } catch (e) {}
const segs = await mic.stop()
// One clock fit per segment: a new device starts its own clock, so a single
// fit across a device change would be a line through two unrelated slopes.
const clocks = mic.segments.map((s, i) => {
  const f = fitProgressClock(s.ticks)
  return { file: path.basename(s.file), device: s.device?.name, ...(f.ok ? f : { ok: false, reason: f.reason }), toWall: undefined }
})
fs.writeFileSync(path.join(OUT, 'micticks.json'), JSON.stringify(mic.segments.map((s) => s.ticks)))
sink.meta({ url: URL_, browserReadyWall: t0, endedWall: Date.now(), events: sink.n,
  mic: segs, micEvents, audioClocks: clocks })
for (const c of clocks) {
  if (!c.ok) { console.log(`audio clock ${c.file}: ${c.reason}`); continue }
  const seg = mic.segments.find((s) => path.basename(s.file) === c.file)
  console.log(`audio clock ${c.file} (${c.device}): sample 0 at +${(c.startWall - seg.startedWall).toFixed(0)}ms, ` +
    `drift ${c.driftPpm}ppm, residual ${c.residualMs}ms (${c.ticks} ticks)`)
}
sink.close()
const mb = segs.reduce((n, s) => n + s.bytes, 0) / 1024 / 1024
console.log(`done: ${sink.n} events, ${segs.length} audio segment(s), ${mb.toFixed(1)}MB`)

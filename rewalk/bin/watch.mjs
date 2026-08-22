// rewalk watch — record a human using a page, with their voice.
//
// Runs until <out>/STOP appears. Everything is written as it arrives: the rrweb
// stream appends to NDJSON, ffmpeg writes the wav continuously. There is no
// write-at-exit path, so killing this at any moment leaves a usable recording.
//
//   node bin/watch.mjs [url] [outDir]
//   touch <outDir>/STOP     # to finish
//
// Then: node bin/read.mjs <outDir>

import fs from 'node:fs'
import path from 'node:path'
import { loadChromium } from '../lib/engine.mjs'
import { bootScript, Sink, startMic, fitProgressClock } from '../lib/record.mjs'

const chromium = await loadChromium()
const URL_ = process.argv[2] ?? 'http://127.0.0.1:51931/lab.html'
const OUT = process.argv[3] ?? 'out/session'
const MIC = process.env.REWALK_MIC ?? ':4'

fs.rmSync(OUT, { recursive: true, force: true })
const sink = new Sink(OUT)
const mic = startMic(OUT, MIC)

const browser = await chromium.launch({
  headless: false,
  args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1360,900'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await ctx.exposeBinding('__rewalkEmit', (_s, batch) => sink.push(batch))
await ctx.addInitScript(bootScript({ mask: false, beacon: process.env.REWALK_BEACON === '1' }))
const page = await ctx.newPage()
await page.goto(URL_, { waitUntil: 'load' })

const t0 = Date.now()
sink.meta({ url: URL_, micDevice: MIC, micStartedWall: mic.started, browserReadyWall: t0 })
console.log(`recording -> ${OUT}`)
console.log(`mic ${MIC}, audio ${mic.wav}`)
console.log(`stop with: touch ${OUT}/STOP`)

let stopped = false
browser.on('disconnected', () => { stopped = true })
while (!stopped && !fs.existsSync(path.join(OUT, 'STOP'))) {
  await new Promise((r) => setTimeout(r, 500))
}

// Finalise what is already on disk rather than write what is held in memory.
// The prototype this replaces hung here with the whole stream unwritten.
try { await page.evaluate(() => window.__rrFlush?.()) } catch (e) {}
await new Promise((r) => setTimeout(r, 400))
try { await browser.close() } catch (e) {}
await mic.stop()
const clock = fitProgressClock(mic.ticks)
fs.writeFileSync(path.join(OUT, 'micticks.json'), JSON.stringify(mic.ticks))
sink.meta({ url: URL_, micDevice: MIC, micStartedWall: mic.started, browserReadyWall: t0,
  endedWall: Date.now(), events: sink.n, audioClock: clock.ok ? clock : { ok: false, reason: clock.reason },
  ffmpeg: mic.stderr().slice(-400) })
if (clock.ok) console.log(`audio clock: sample 0 at +${(clock.startWall - mic.started).toFixed(0)}ms, ` +
  `drift ${clock.driftPpm}ppm, residual ${clock.residualMs}ms (${clock.ticks} ticks)`)
sink.close()
const size = fs.existsSync(mic.wav) ? fs.statSync(mic.wav).size : 0
console.log(`done: ${sink.n} events, audio ${(size / 1024 / 1024).toFixed(1)}MB`)

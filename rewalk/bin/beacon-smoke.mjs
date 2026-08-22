// Can the microphone actually hear the beacon?
//
// This is the one part of the alignment path that synthetic audio cannot test:
// speakers loud enough, mic close enough, room not swallowing 1970Hz. Fifteen
// seconds, scripted, no human required. Run it before asking anyone to speak.
//
// It is also the only instrument that can *check* the clock the CLI actually
// uses. `fitProgressClock` reads ffmpeg's own progress reports, which needs no
// sound at all, but its intercept is late by however long ffmpeg takes to
// encode and flush a report -- a bias that has been asserted to be small and
// never measured. The beacon sees the sound itself, so the gap between the two
// intercepts IS that bias. That is what the last line of this report is.
//
//   node bin/beacon-smoke.mjs [url]

import fs from 'node:fs'
import { loadChromium } from '../lib/engine.mjs'
import { bootScript, Sink, startMic, fitProgressClock } from '../lib/record.mjs'
import { readStream } from '../lib/deltas.mjs'
import { readPcm, findBeacons, fitAudioClock } from '../lib/align.mjs'
import { defaultMicSpec } from '../lib/audio-device.mjs'

const chromium = await loadChromium()
const URL_ = process.argv[2] ?? 'http://127.0.0.1:51931/lab.html'
const OUT = 'out/beacon-smoke'

// Whichever microphone the person chose. A hardcoded index means recording the
// webcam because a USB device was unplugged last week, which is the whole
// reason lib/audio-device.mjs exists.
const picked = process.env.REWALK_MIC ? { ok: true, spec: process.env.REWALK_MIC, name: `(REWALK_MIC ${process.env.REWALK_MIC})` }
  : defaultMicSpec()
if (!picked.ok) { console.error(`no usable default microphone: ${picked.reason}`); process.exit(2) }
console.log(`microphone ${picked.name} (avfoundation ${picked.spec})`)

fs.rmSync(OUT, { recursive: true, force: true })
const sink = new Sink(OUT)
const mic = startMic(OUT, picked.spec)

const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } })
await ctx.exposeBinding('__rewalkEmit', (_s, b) => sink.push(b))
// beacon: true. Without this the page emits nothing, the detector finds
// nothing, and the report blames the speakers for a bug in the harness.
await ctx.addInitScript(bootScript({ mask: false, beacon: true }))
const page = await ctx.newPage()
await page.goto(URL_, { waitUntil: 'load' })
await page.waitForTimeout(600)
await page.click('#next')            // first gesture: unblocks audio, starts beacons
console.log('listening for beacons (16s)...')
for (let i = 0; i < 5; i++) { await page.waitForTimeout(3200); await page.click('#next') }
await page.evaluate(() => window.__rrFlush?.())
await page.waitForTimeout(500)
await browser.close()
await mic.stop()
sink.close()

const events = readStream(fs.readFileSync(`${OUT}/events.ndjson`, 'utf8'))
const stamped = events.filter((e) => e.type === 5 && e.data.tag === 'rewalk-beacon')
  .map((e) => ({ ...e.data.payload }))
const { samples, sampleRate } = readPcm(`${OUT}/audio.wav`)
let peak = 0, sum = 0
for (const s of samples) { peak = Math.max(peak, Math.abs(s)); sum += s * s }
const heard = findBeacons(samples, sampleRate)

console.log(`\naudio      ${(samples.length / sampleRate).toFixed(1)}s, peak ${peak.toFixed(3)}, rms ${Math.sqrt(sum / samples.length).toFixed(5)}`)
console.log(`stamped    ${stamped.length} beacons emitted by the page`)
console.log(`heard      ${heard.length} detected in the waveform`)
const failed = stamped.find((b) => b.error)
if (failed) console.log(`page error ${failed.error}`)

// The three failures are different problems with different fixes, and a report
// that collapses them into "check your speakers" sends you to the wrong place.
if (!stamped.length) {
  console.log(`\nVERDICT    the PAGE emitted no beacon. Not an audio problem: either bootScript`)
  console.log(`           was called without {beacon:true}, or the first click never landed.`)
  process.exit(1)
}
if (heard.length < 2) {
  console.log(`\nVERDICT    the page played ${stamped.length} tones and the microphone heard ${heard.length}.`)
  console.log(`           The acoustic path is the failure: output routed to headphones or a`)
  console.log(`           DAC the mic cannot hear, volume too low, or the room swallowing 1970Hz.`)
  process.exit(1)
}

const fit = fitAudioClock(heard, stamped)
if (!fit.ok) { console.log(`\nVERDICT    heard ${heard.length}, but pairing failed: ${fit.reason}`); process.exit(1) }
console.log(`fit        paired ${fit.pairs}/${stamped.length}, drift ${fit.driftPpm}ppm, residual ${fit.residualMs}ms`)
console.log(`capture    audio sample 0 is ${(fit.startWall - mic.started).toFixed(0)}ms after ffmpeg was asked to start`)

// The measurement this exists for now that the CLI does not use the beacon.
const prog = fitProgressClock(mic.ticks)
if (prog.ok) {
  const bias = prog.startWall - fit.startWall
  console.log(`\nprogress clock (what the CLI actually uses, no sound required)`)
  console.log(`           ${prog.ticks} ticks, drift ${prog.driftPpm}ppm, residual ${prog.residualMs}ms`)
  console.log(`           sample 0 at +${(prog.startWall - mic.started).toFixed(0)}ms vs the beacon's +${(fit.startWall - mic.started).toFixed(0)}ms`)
  console.log(`BIAS       ffmpeg's progress reports put sample 0 ${bias > 0 ? `${bias.toFixed(0)}ms LATE` : `${(-bias).toFixed(0)}ms EARLY`}`)
  console.log(`           drift disagreement ${(prog.driftPpm - fit.driftPpm).toFixed(1)}ppm`)
} else {
  console.log(`\nprogress clock unusable: ${prog.reason}`)
}

console.log(`\nVERDICT    ${fit.residualMs < 80 ? 'beacon path WORKS — the acoustic anchor is real' : 'heard, but the fit is loose; check speaker volume'}`)

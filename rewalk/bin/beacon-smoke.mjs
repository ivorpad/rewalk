// Can the microphone actually hear the beacon?
//
// This is the one part of the alignment path that synthetic audio cannot test:
// speakers loud enough, mic close enough, room not swallowing 1970Hz. Twelve
// seconds, scripted, no human required. Run it before asking anyone to speak.

import fs from 'node:fs'
import { loadChromium } from '../lib/engine.mjs'
import { bootScript, Sink, startMic } from '../lib/record.mjs'
import { readStream, extractMarks } from '../lib/deltas.mjs'
import { readPcm, findBeacons, fitAudioClock } from '../lib/align.mjs'

const chromium = await loadChromium()
const URL_ = process.argv[2] ?? 'http://127.0.0.1:51931/lab.html'
const OUT = 'out/beacon-smoke'
const MIC = process.env.REWALK_MIC ?? ':4'

fs.rmSync(OUT, { recursive: true, force: true })
const sink = new Sink(OUT)
const mic = startMic(OUT, MIC)

const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } })
await ctx.exposeBinding('__rewalkEmit', (_s, b) => sink.push(b))
await ctx.addInitScript(bootScript({ mask: false }))
const page = await ctx.newPage()
await page.goto(URL_, { waitUntil: 'load' })
await page.waitForTimeout(600)
await page.click('#next')            // first gesture: unblocks audio, starts beacons
console.log('listening for beacons (14s)...')
for (let i = 0; i < 4; i++) { await page.waitForTimeout(3200); await page.click('#next') }
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
if (stamped.some((b) => b.error)) console.log(`page error ${stamped.find((b) => b.error).error}`)

if (heard.length >= 2 && stamped.length >= 2) {
  const fit = fitAudioClock(heard, stamped)
  if (fit.ok) {
    console.log(`fit        paired ${fit.pairs}/${stamped.length}, drift ${fit.driftPpm}ppm, residual ${fit.residualMs}ms`)
    const lag = fit.startWall - mic.started
    console.log(`capture    audio sample 0 is ${lag.toFixed(0)}ms from when ffmpeg was asked to start`)
    console.log(`\nVERDICT    ${fit.residualMs < 80 ? 'beacon path WORKS — safe to record a human' : 'fit is loose; check speaker volume'}`)
  } else console.log(`\nVERDICT    pairing failed: ${fit.reason}`)
} else {
  console.log(`\nVERDICT    beacon NOT heard. Speakers muted, output on headphones, or volume too low.`)
}

// Does the beacon detector actually recover the audio clock?
//
// Synthesise audio whose truth we set: a capture that started 137ms late, a
// sound card running 320ppm fast, tones where the page said it emitted them,
// and speech-like noise on top. Then check the fit gets the offset and the drift
// back. The microphone is not the risky part of this; the detector is.

import fs from 'node:fs'
import path from 'node:path'
import { readPcm, findBeacons, fitAudioClock } from '../lib/align.mjs'

const RATE = 16000
const OUT = 'out/align'
fs.mkdirSync(OUT, { recursive: true })

// --- ground truth ---------------------------------------------------------
const TRUE_START_WALL = 1_800_000_000_000   // wall time of audio sample 0
const TRUE_DRIFT_PPM = 320                  // sound card runs fast
const EPOCH = TRUE_START_WALL - 137         // page started 137ms before capture
const N = 8, EVERY = 5000, TONE_MS = 120, FREQ = 1970

// The page stamps these when it schedules each tone.
const beacons = Array.from({ length: N }, (_, k) => ({ seq: k, wall: EPOCH + 900 + k * EVERY }))

// Where each tone lands in the audio file, given the true start and drift.
const wallToAudioMs = (w) => (w - TRUE_START_WALL) / (1 + TRUE_DRIFT_PPM / 1e6)

function synth({ noise = 0.02, speech = true }) {
  const durMs = wallToAudioMs(beacons[N - 1].wall) + 4000
  const n = Math.ceil((durMs / 1000) * RATE)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = (Math.random() * 2 - 1) * noise
    if (speech) {
      // broadband-ish babble with energy under 1kHz, which is what should NOT
      // trip a tone detector
      const t = i / RATE
      x[i] += 0.12 * Math.sin(2 * Math.PI * 180 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.1 * t))
      x[i] += 0.08 * Math.sin(2 * Math.PI * 420 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 1.7 * t))
      x[i] += 0.05 * Math.sin(2 * Math.PI * 900 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 5.3 * t))
    }
  }
  for (const b of beacons) {
    const startS = Math.round((wallToAudioMs(b.wall) / 1000) * RATE)
    const len = Math.round((TONE_MS / 1000) * RATE)
    const ramp = Math.round(0.012 * RATE)
    for (let i = 0; i < len; i++) {
      const s = startS + i
      if (s < 0 || s >= n) continue
      const env = Math.min(1, i / ramp, (len - i) / ramp)
      x[s] += 0.06 * env * Math.sin((2 * Math.PI * FREQ * i) / RATE)
    }
  }
  return x
}

function writeWav(file, x) {
  const data = Buffer.alloc(x.length * 2)
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([h, data]))
}

const CASES = [
  { name: 'quiet room', noise: 0.005, speech: false },
  { name: 'speech over it', noise: 0.02, speech: true },
  { name: 'noisy + speech', noise: 0.08, speech: true },
]

let bad = 0
console.log(`truth: audio sample 0 = wall ${TRUE_START_WALL}, drift ${TRUE_DRIFT_PPM} ppm, ${N} beacons\n`)
for (const c of CASES) {
  const file = path.join(OUT, c.name.replace(/\W+/g, '-') + '.wav')
  writeWav(file, synth(c))
  const { samples, sampleRate } = readPcm(file)
  const onsets = findBeacons(samples, sampleRate, { freq: FREQ })
  const fit = fitAudioClock(onsets, beacons)
  if (!fit.ok) { console.log(`${c.name.padEnd(16)} FAIL  ${fit.reason}`); bad++; continue }
  const dStart = Math.abs(fit.startWall - TRUE_START_WALL)
  const dDrift = Math.abs(fit.driftPpm - TRUE_DRIFT_PPM)
  // A single guessed anchor would be wrong by the capture latency, every time.
  const naive = Math.abs(beacons[0].wall - TRUE_START_WALL)
  const ok = onsets.length === N && dStart <= 15 && dDrift <= 120
  if (!ok) bad++
  console.log(`${c.name.padEnd(16)} ${ok ? 'ok  ' : 'FAIL'}  found ${onsets.length}/${N}` +
    `  start off by ${dStart.toFixed(1)}ms  drift ${fit.driftPpm}ppm (off by ${dDrift.toFixed(0)})` +
    `  residual ${fit.residualMs}ms`)
  console.log(`${''.padEnd(16)}       anchoring on the first beacon instead would be off by ${naive.toFixed(0)}ms`)
}
console.log(`\n${CASES.length - bad}/${CASES.length} conditions recovered the audio clock`)
process.exit(bad ? 1 : 0)

// Is this microphone hearing a person?
//
// Written because a three minute session was recorded, transcribed, and only
// then found to contain no speech at all: 199 seconds at a dead flat 0.30 RMS,
// which Whisper labelled [Music] end to end. Nothing in the pipeline noticed,
// because nothing in the pipeline was looking.
//
// Level alone does not answer the question -- a loud constant hiss and a person
// talking can share an RMS. What separates them is *dynamics*: speech has gaps
// between words and phrases, and a continuous noise source does not. So the
// test is the spread between the quiet percentile and the loud one.
//
// Capture is the signed bundle (lib/mac/rewalk-mic.app), the same capturer
// every recording route uses — so this checks the path that will actually run,
// not a lookalike.
//
//   node bin/mic-check.mjs [seconds]

import fs from 'node:fs'
import { defaultInput } from '../lib/audio-device.mjs'
import { BundleMic, bundleAvailable } from '../lib/mac/bundle-mic.mjs'
import { readPcm } from '../lib/align.mjs'

const SECS = Number(process.argv[2] ?? 6)
const OUT = 'out/miccheck'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

if (!bundleAvailable()) {
  console.error('rewalk-mic.app is not built — see lib/mac/rewalk-mic-src/README.md')
  process.exit(2)
}
const dev = defaultInput()
console.log(dev.ok ? `default input: ${dev.name}  (${dev.inputChannels}ch)` : `default input unknown: ${dev.reason}`)
console.log(`say something for ${SECS}s...`)

const mic = await new BundleMic(OUT, { onEvent: () => {} }).startAsync({ audition: false })
await new Promise((r) => setTimeout(r, SECS * 1000))
await mic.stop()

const { samples, sampleRate } = readPcm(mic.segments[0].file)
const win = Math.round(sampleRate * 0.05)
const frames = []
for (let i = 0; i + win < samples.length; i += win) {
  let s = 0
  for (let j = 0; j < win; j++) s += samples[i + j] ** 2
  frames.push(Math.sqrt(s / win))
}
if (!frames.length) { console.error('no audio captured'); process.exit(2) }
const sorted = [...frames].sort((a, b) => a - b)
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
const floor_ = q(0.1), mid = q(0.5), loud = q(0.95)
const peak = Math.max(...samples.map(Math.abs))
const clipped = samples.reduce((n, v) => n + (Math.abs(v) > 0.98 ? 1 : 0), 0) / samples.length
// A talker leaves gaps; a fan does not. 6x between the quiet and loud
// percentiles is comfortably past anything stationary and well under what a
// real voice produces.
const dyn = floor_ > 0 ? loud / floor_ : (loud > 0 ? Infinity : 1)

const bar = (v) => '#'.repeat(Math.min(40, Math.round(v * 120))).padEnd(40, '.')
console.log(`\nquiet  ${floor_.toFixed(4)} ${bar(floor_)}`)
console.log(`median ${mid.toFixed(4)} ${bar(mid)}`)
console.log(`loud   ${loud.toFixed(4)} ${bar(loud)}`)
console.log(`peak ${peak.toFixed(3)}  clipped ${(clipped * 100).toFixed(2)}%  dynamic range ${dyn === Infinity ? 'inf' : dyn.toFixed(1) + 'x'}`)

const problems = []
if (peak < 0.005) problems.push('silent — the microphone grant is probably denied (System Settings > Privacy & Security > Microphone; approve rewalk-mic if prompted)')
else if (dyn < 3) problems.push(`no gaps between loud and quiet (${dyn.toFixed(1)}x) — this is a continuous sound source, not someone talking`)
if (clipped > 0.01) problems.push(`${(clipped * 100).toFixed(1)}% of samples clipped — input gain is too high`)
if (peak >= 0.005 && loud < 0.02) problems.push('very quiet — speech may transcribe poorly')

if (problems.length) {
  console.log(`\nNOT READY`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
console.log(`\nREADY — this microphone is hearing a person`)

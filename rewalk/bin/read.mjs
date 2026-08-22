// rewalk read — utterances resolved to DOM deltas.
//
// Transcribes locally, converts audio time to wall time with the clock fit the
// recorder measured, and runs each utterance through the join.
//
// Utterances are re-segmented from word timestamps rather than taken from
// whisper's own segments. Whisper hands back 10-second blocks, and a 10-second
// block is three times wider than the window the join searches -- anchoring on
// its start point puts the utterance seconds away from the thing it describes.
// Splitting on pauses gives phrases, which is the unit a person actually
// complains in.
//
//   node bin/read.mjs <sessionDir>

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readStream, buildMirror, extractDeltas, extractMarks, extractObserved } from '../lib/deltas.mjs'
import { churnProfile, resolveUtterance } from '../lib/resolve.mjs'

const DIR = process.argv[2] ?? 'out/session2'
const MODEL = process.env.REWALK_WHISPER_MODEL ??
  '/Users/ivor/Library/Application Support/Screen Studio/models/ggml-small.bin'
const GAP_MS = Number(process.env.REWALK_UTTERANCE_GAP ?? 700)

const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'session.json'), 'utf8'))
const clock = (meta.audioClocks ?? []).find((c) => c.ok)
if (!clock) { console.error('no usable audio clock in session.json'); process.exit(2) }
const a = 1 + (clock.driftPpm ?? 0) / 1e6
const toWall = (audioMs) => a * audioMs + clock.startWall

// --- utterances -----------------------------------------------------------
//
// Segment on energy in the waveform, then transcribe each region on its own.
//
// The previous version transcribed the whole file with word timestamps and
// assigned words to regions by their reported midpoints. That mixes two time
// sources of very different quality: regions are accurate because they come
// from the audio, word times are not, because with -ml 1 whisper stretches each
// word to fill its decode span (measured: 0ms gap between consecutive words at
// the 90th percentile). Words landed in neighbouring regions, which merged two
// separate complaints into one line and cut another mid-word.
//
// Transcribing each region separately means the text and the start time come
// from the same place, and a boundary is a real silence rather than a guess.
const wav = path.join(DIR, clock.file)
const { readPcm } = await import('../lib/align.mjs')
const pcm = readPcm(wav)

function speechRegions(samples, rate, { padMs = 150, joinMs = 450, minMs = 350 } = {}) {
  const win = Math.round(rate * 0.025)
  const frames = []
  for (let i = 0; i + win < samples.length; i += win) {
    let s = 0
    for (let j = 0; j < win; j++) s += samples[i + j] ** 2
    frames.push(Math.sqrt(s / win))
  }
  const sorted = [...frames].sort((x, y) => x - y)
  const floor_ = sorted[Math.floor(sorted.length * 0.1)]
  const loud = sorted[Math.floor(sorted.length * 0.95)]
  const thresh = Math.max(floor_ * 2.5, floor_ + (loud - floor_) * 0.1)
  const ms = (win / rate) * 1000
  const raw = []
  let run = null
  frames.forEach((v, i) => {
    if (v >= thresh) { run = run ?? { from: i * ms, to: 0 }; run.to = (i + 1) * ms }
    else if (run && i * ms - run.to > joinMs) { raw.push(run); run = null }
  })
  if (run) raw.push(run)
  // Pad outwards: a word's opening consonant is quieter than its vowel and gets
  // clipped by any threshold that is not also cutting the room in half.
  return raw.filter((r) => r.to - r.from >= minMs)
    .map((r) => ({ from: Math.max(0, r.from - padMs), to: r.to + padMs }))
}

function writeWav(file, samples, rate) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++)
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([h, data]))
}

const regions = speechRegions(pcm.samples, pcm.sampleRate)
const tmp = path.join(DIR, 'regions')
fs.mkdirSync(tmp, { recursive: true })
const utterances = []
for (const [i, r] of regions.entries()) {
  const a = Math.round((r.from / 1000) * pcm.sampleRate)
  const b = Math.min(pcm.samples.length, Math.round((r.to / 1000) * pcm.sampleRate))
  const base = path.join(tmp, 'r' + String(i).padStart(3, '0'))
  if (!fs.existsSync(base + '.wav')) writeWav(base + '.wav', pcm.samples.subarray(a, b), pcm.sampleRate)
  if (!fs.existsSync(base + '.json')) {
    const res = spawnSync('whisper-cli', [
      '-m', MODEL, '-f', base + '.wav', '-oj', '-of', base, '-np', '-l', 'en'], { encoding: 'utf8' })
    if (res.status !== 0) continue
  }
  let text = ''
  try {
    text = JSON.parse(fs.readFileSync(base + '.json', 'utf8')).transcription
      .map((t) => String(t.text)).join(' ').replace(/\s+/g, ' ').trim()
  } catch (e) { continue }
  text = text.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim()
  if (text) utterances.push({ text, from: r.from, to: r.to })
}

// --- the stream -----------------------------------------------------------
const events = readStream(fs.readFileSync(path.join(DIR, 'events.ndjson'), 'utf8'))
const mirror = buildMirror(events)
const deltas = extractDeltas(events, mirror)
const { marks } = extractMarks(events)
const observed = extractObserved(events)
const churn = churnProfile(deltas, marks, observed)

console.log(`${events.length} events, ${deltas.length} deltas, ${marks.length} interactions`)
console.log(`audio clock: start ${clock.startWall}, drift ${clock.driftPpm}ppm, residual ${clock.residualMs}ms`)
console.log(`${regions.length} speech regions -> ${utterances.length} utterances, each transcribed on its own
`)

const t0 = marks.length ? Math.min(...marks.map((m) => m.at)) : toWall(0)
const rel = (w) => `+${((w - t0) / 1000).toFixed(1)}s`
const out = []
for (const u of utterances) {
  if (u.text.split(/\s+/).length < 3) continue          // "short." is not a complaint
  const at = toWall(u.from)
  const r = resolveUtterance({ text: u.text, at }, { deltas, marks, churn })
  out.push(r)
  const list = r.query === 'stasis' ? (r.held.length ? r.held : r.deltas) : r.deltas
  console.log(`${rel(at)}  "${u.text.slice(0, 88)}${u.text.length > 88 ? '…' : ''}"`)
  console.log(`        ${r.query}${r.pointedAt ? `, pointed at ${r.pointedAt}` : ''}, ${r.interactions.length} interaction(s) in window`)
  for (const d of list.slice(0, 3)) {
    const w = d.from != null && d.to != null ? `  ${d.from} -> ${d.to}` : ''
    const c = d.changedInSteps !== undefined ? `  (changed in ${d.changedInSteps}/${d.ofSteps} steps)` : ''
    console.log(`        ${String(d.score).padStart(6)}  ${d.node} ${d.prop}${w}${c}`)
  }
  console.log()
}
fs.writeFileSync(path.join(DIR, 'resolved.json'), JSON.stringify(out, null, 1))
console.log(`${out.length} utterances resolved -> ${path.join(DIR, 'resolved.json')}`)

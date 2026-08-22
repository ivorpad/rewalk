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

// --- transcribe, word by word --------------------------------------------
const wav = path.join(DIR, clock.file)
const prefix = path.join(DIR, 'words')
if (!fs.existsSync(`${prefix}.json`)) {
  const r = spawnSync('whisper-cli', ['-m', MODEL, '-f', wav, '-oj', '-of', prefix,
    '-np', '-l', 'en', '-ml', '1', '-sow'], { encoding: 'utf8' })
  if (r.status !== 0) { console.error(r.stderr?.slice(-500)); process.exit(2) }
}
const words = JSON.parse(fs.readFileSync(`${prefix}.json`, 'utf8')).transcription
  .map((t) => ({ text: String(t.text).trim(), from: t.offsets.from, to: t.offsets.to }))
  .filter((w) => w.text && !/^\[.*\]$/.test(w.text))

// Pauses come from the audio, not from whisper.
//
// With -ml 1 whisper reports every word as abutting the next -- measured, the
// gap between consecutive words is 0ms at the 90th percentile -- because it
// stretches each word to fill the span it was decoded in. There are no pauses
// in those timings to split on, so 89 words collapsed into 2 utterances. The
// silence is plainly there in the waveform, so read it from there.
function speechRegions(samples, rate) {
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
  // Between the room and the voice. Relative, so it survives a quiet talker
  // and a hot input alike.
  const thresh = Math.max(floor_ * 2.5, floor_ + (loud - floor_) * 0.12)
  const frameMs = (win / rate) * 1000
  const regions = []
  let run = null
  frames.forEach((v, i) => {
    if (v >= thresh) { run = run ?? { from: i * frameMs, to: 0 }; run.to = (i + 1) * frameMs }
    else if (run && i * frameMs - run.to > 400) { regions.push(run); run = null }
  })
  if (run) regions.push(run)
  return regions.filter((r) => r.to - r.from >= 250)
}

const { readPcm } = await import('../lib/align.mjs')
const pcm = readPcm(wav)
const regions = speechRegions(pcm.samples, pcm.sampleRate)

// A word belongs to the region its midpoint falls in; words in no region are
// attached to the nearest one so nothing is silently dropped.
const utterances = regions.map((r) => ({ text: '', from: r.from, to: r.to }))
for (const w of words) {
  const mid = (w.from + w.to) / 2
  let best = -1, bestD = Infinity
  regions.forEach((r, i) => {
    const d = mid < r.from ? r.from - mid : mid > r.to ? mid - r.to : 0
    if (d < bestD) { bestD = d; best = i }
  })
  if (best >= 0) utterances[best].text += (utterances[best].text ? ' ' : '') + w.text
}
for (const u of utterances) u.text = u.text.trim()

// --- the stream -----------------------------------------------------------
const events = readStream(fs.readFileSync(path.join(DIR, 'events.ndjson'), 'utf8'))
const mirror = buildMirror(events)
const deltas = extractDeltas(events, mirror)
const { marks } = extractMarks(events)
const observed = extractObserved(events)
const churn = churnProfile(deltas, marks, observed)

console.log(`${events.length} events, ${deltas.length} deltas, ${marks.length} interactions`)
console.log(`audio clock: start ${clock.startWall}, drift ${clock.driftPpm}ppm, residual ${clock.residualMs}ms`)
console.log(`${words.length} words -> ${utterances.length} utterances (split on silence in the waveform)\n`)

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

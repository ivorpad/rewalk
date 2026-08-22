// rewalk read — utterances resolved to DOM deltas.
//
// Transcribes, converts audio time to wall time with the clock fit the recorder
// measured, and runs each utterance through the join.
//
// Utterance boundaries come from energy in the waveform, not from the
// transcript. Whisper hands back 10-second blocks, and a 10-second block is
// three times wider than the window the join searches -- anchoring on its start
// point puts the utterance seconds away from the thing it describes.
//
// The segmentation and transcription used to live here as a second copy of what
// is in lib/utterances.mjs. They drifted: the clamp that stops the speech
// threshold exceeding the loudest frame in the file was fixed in the library
// and not here, so this path could still report zero utterances for a bad
// recording instead of saying the recording was bad. One copy now.
//
//   node bin/read.mjs <sessionDir>
//   REWALK_STT=deepgram node bin/read.mjs <sessionDir>

import fs from 'node:fs'
import path from 'node:path'
import { readStream, buildMirror, extractDeltas, extractMarks, extractObserved } from '../lib/deltas.mjs'
import { churnProfile, resolveUtterance } from '../lib/resolve.mjs'
import { transcribe, clockOf, DEFAULT_ENGINE } from '../lib/utterances.mjs'
import { readPcm } from '../lib/align.mjs'

const DIR = process.argv[2] ?? 'out/session2'

const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'session.json'), 'utf8'))
const rawClock = (meta.audioClocks ?? []).find((c) => c.ok)
if (!rawClock) { console.error('no usable audio clock in session.json'); process.exit(2) }
const pcm = readPcm(path.join(DIR, rawClock.file))
// clockOf reconciles ffmpeg's reported position against what is actually in the
// file: out_time advances with the wall clock, so a capture that drops audio
// maps every position to a wall time that is too early, by a margin that grows.
const clock = clockOf(meta, (pcm.samples.length / pcm.sampleRate) * 1000)
const toWall = clock.toWall

const { utterances, regions, engine, failures } = await transcribe(DIR, clock.file)
for (const f of failures) console.error(`region ${f.region} not transcribed: ${f.reason}`)

// --- the stream -----------------------------------------------------------
const events = readStream(fs.readFileSync(path.join(DIR, 'events.ndjson'), 'utf8'))
const mirror = buildMirror(events)
const deltas = extractDeltas(events, mirror)
const { marks } = extractMarks(events)
const observed = extractObserved(events)
const churn = churnProfile(deltas, marks, observed)

console.log(`${events.length} events, ${deltas.length} deltas, ${marks.length} interactions`)
console.log(`audio clock: start ${clock.startWall}, drift ${clock.driftPpm}ppm, residual ${clock.residualMs}ms` +
  (clock.corrected ? `  [stretched: capture dropped ${(clock.dropRate * 100).toFixed(1)}% of the audio]` : ''))
console.log(`${regions.length} speech regions -> ${utterances.length} utterances via ${engine}` +
  (failures.length ? `, ${failures.length} failed` : '') + `
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

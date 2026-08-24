// rewalk stream-audio — the voice companion daemon, live to Deepgram.
//
// Same reason as record-audio.mjs: the browser cannot own the mic on macOS, so
// voice is captured by a separate process that is its own responsible process.
// This one streams to Deepgram as it records, so utterances land wall-stamped in
// real time (Deepgram's own segmentation, the boundaries that beat energy VAD),
// and no batch transcription pass is needed afterward. It still writes the wav,
// so the replay has audio and the session stays re-readable offline.
//
//   node bin/stream-audio.mjs [outDir]              live mic
//   node bin/stream-audio.mjs [outDir] --from-wav <p>   replay a wav (for testing)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { BundleMic, bundleAvailable } from '../lib/mac/bundle-mic.mjs'
import { fitProgressClock } from '../lib/record.mjs'
import { openDeepgramStream, wavDataOffset } from '../lib/dg-stream.mjs'
import { readPcm } from '../lib/align.mjs'

const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : `out/audio-${Date.now()}`
const fromWavIx = process.argv.indexOf('--from-wav')
const fromWav = fromWavIx >= 0 ? process.argv[fromWavIx + 1] : null
fs.mkdirSync(OUT, { recursive: true })

const dg = openDeepgramStream({ onUtterance: (u) => console.log(`  [+${(u.from / 1000).toFixed(1)}s] ${u.text}`) })
const startedWall = Date.now()
let stopFn, clocks = [], segs = []

if (fromWav) {
  // Test path: stream an existing recording, no mic. Proves the wall-stamping
  // and Deepgram path without anyone speaking.
  const { samples, sampleRate } = readPcm(fromWav)
  const raw = fs.readFileSync(fromWav)
  const pcm = raw.subarray(wavDataOffset(raw))
  fs.copyFileSync(fromWav, path.join(OUT, 'audio.1.wav'))
  console.log(`streaming ${(samples.length / sampleRate).toFixed(1)}s from ${fromWav}`)
  const chunk = 16000 * 2 * 0.1 | 0
  for (let i = 0; i < pcm.length; i += chunk) { dg.push(pcm.subarray(i, i + chunk)); await new Promise((r) => setTimeout(r, 10)) }
  // No real clock ticks in test mode: identity clock anchored at startedWall.
  clocks = [{ file: 'audio.1.wav', ok: true, startWall: startedWall, driftPpm: 0, residualMs: 0, ticks: 0 }]
  segs = [{ file: 'audio.1.wav', bytes: fs.statSync(path.join(OUT, 'audio.1.wav')).size }]
} else {
  if (!bundleAvailable()) { console.error('rewalk-mic.app is not built'); process.exit(3) }
  const mic = await new BundleMic(OUT, { onEvent: (e) => console.log(`[mic] ${e.kind} ${e.device ?? ''}`) })
    .startAsync({ audition: process.env.REWALK_SKIP_AUDITION !== '1' }).catch((e) => { console.error(`REFUSING: ${e.message}`); process.exit(3) })
  const wav = path.join(OUT, 'audio.1.wav')
  // Tail the wav the bundle writes and stream new bytes. One capture, two
  // consumers (durable wav + live stream), no change to the signed bundle.
  let sent = 0
  const tail = setInterval(() => {
    try { const sz = fs.statSync(wav).size; const start = Math.max(44, sent || 44)
      if (sz > start) { const fd = fs.openSync(wav, 'r'); const b = Buffer.alloc(sz - start); fs.readSync(fd, b, 0, b.length, start); fs.closeSync(fd); dg.push(b); sent = sz } }
    catch (e) {}
  }, 200)
  // Two stop signals. The STOP file is the manual fallback. The primary one is
  // the extension host finalizing its half in this same dir: clicking the
  // rewalk button to stop closes the native port, and the host's last act is
  // writing session.json with via:'extension'. Watching for that file makes the
  // browser button end the whole paired recording — the terminal is never
  // touched again after launch. The mtime guard ignores a session.json that
  // predates this run (a re-used outDir).
  const hostFinalized = () => {
    try {
      const p = path.join(OUT, 'session.json')
      if (fs.statSync(p).mtimeMs < startedWall) return false
      return JSON.parse(fs.readFileSync(p, 'utf8')).via === 'extension'
    } catch (e) { return false }
  }
  console.log(`recording voice -> ${OUT}`)
  console.log(`stop with the rewalk button in Chrome (or: touch ${OUT}/STOP)`)
  while (!fs.existsSync(path.join(OUT, 'STOP')) && !hostFinalized()) await new Promise((r) => setTimeout(r, 400))
  clearInterval(tail)
  segs = await mic.stop()
  clocks = mic.segments.map((s) => { const f = fitProgressClock(s.ticks); return { file: path.basename(s.file), ...(f.ok ? f : { ok: false, reason: f.reason }), toWall: undefined } })
}

const utts = await dg.finish()
const clk = clocks.find((c) => c.ok)
const a = 1 + ((clk?.driftPpm ?? 0) / 1e6), b = clk?.startWall ?? startedWall
const toWall = (ms) => a * ms + b
const stamped = utts.map((u) => ({ ...u, wall: Math.round(toWall(u.from)) }))
fs.writeFileSync(path.join(OUT, 'utterances.ndjson'), stamped.map((u) => JSON.stringify(u)).join('\n') + (stamped.length ? '\n' : ''))
fs.writeFileSync(path.join(OUT, 'audio-meta.json'), JSON.stringify(
  { startedWall, endedWall: Date.now(), kind: 'rewalk-audio-companion', streamed: true, mic: segs, audioClocks: clocks, utterances: stamped.length }, null, 1))
console.log(`done: ${segs.length} segment(s), ${stamped.length} utterances streamed -> ${OUT}`)

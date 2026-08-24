// rewalk stream-audio — the voice companion daemon, live to Deepgram.
//
// Same reason as record-audio.mjs: the browser cannot own the mic on macOS, so
// voice is captured by a separate process that is its own responsible process.
// This one streams to Deepgram as it records, so utterances land wall-stamped in
// real time (Deepgram's own segmentation, the boundaries that beat energy VAD),
// and no batch transcription pass is needed afterward. It still writes the wav,
// so the replay has audio and the session stays re-readable offline.
//
// The live path is lib/voice.mjs (shared with bin/daemon.mjs); only the
// --from-wav test mode is inline here, because it streams a file, not a mic.
//
//   node bin/stream-audio.mjs [outDir]              live mic
//   node bin/stream-audio.mjs [outDir] --from-wav <p>   replay a wav (for testing)
import fs from 'node:fs'
import path from 'node:path'
import { recordVoice, writeVoiceArtifacts, hostFinalized } from '../lib/voice.mjs'
import { openDeepgramStream, wavDataOffset } from '../lib/dg-stream.mjs'
import { readPcm } from '../lib/align.mjs'

const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : `out/audio-${Date.now()}`
const fromWavIx = process.argv.indexOf('--from-wav')
const fromWav = fromWavIx >= 0 ? process.argv[fromWavIx + 1] : null
fs.mkdirSync(OUT, { recursive: true })
const startedWall = Date.now()
const sayUtterance = (u) => console.log(`  [+${(u.from / 1000).toFixed(1)}s] ${u.text}`)

if (fromWav) {
  // Test path: stream an existing recording, no mic. Proves the wall-stamping
  // and Deepgram path without anyone speaking.
  const dg = openDeepgramStream({ onUtterance: sayUtterance })
  const { samples, sampleRate } = readPcm(fromWav)
  const raw = fs.readFileSync(fromWav)
  const pcm = raw.subarray(wavDataOffset(raw))
  fs.copyFileSync(fromWav, path.join(OUT, 'audio.1.wav'))
  console.log(`streaming ${(samples.length / sampleRate).toFixed(1)}s from ${fromWav}`)
  const chunk = 16000 * 2 * 0.1 | 0
  for (let i = 0; i < pcm.length; i += chunk) { dg.push(pcm.subarray(i, i + chunk)); await new Promise((r) => setTimeout(r, 10)) }
  const utts = await dg.finish()
  // No real clock ticks in test mode: identity clock anchored at startedWall.
  const clocks = [{ file: 'audio.1.wav', ok: true, startWall: startedWall, driftPpm: 0, residualMs: 0, ticks: 0 }]
  const segs = [{ file: 'audio.1.wav', bytes: fs.statSync(path.join(OUT, 'audio.1.wav')).size }]
  const { utterances } = writeVoiceArtifacts(OUT, { startedWall, segs, clocks, utts })
  console.log(`done: ${segs.length} segment(s), ${utterances.length} utterances streamed -> ${OUT}`)
} else {
  // Two stop signals. The STOP file is the manual fallback. The primary one is
  // the extension host finalizing its half in this same dir: clicking the
  // rewalk button to stop closes the native port, and the host's last act is
  // writing session.json with via:'extension'. Watching for that file makes
  // the browser button end the whole paired recording.
  const stopWhen = () => fs.existsSync(path.join(OUT, 'STOP')) || hostFinalized(OUT, startedWall)
  console.log(`recording voice -> ${OUT}`)
  console.log(`stop with the rewalk button in Chrome (or: touch ${OUT}/STOP)`)
  const r = await recordVoice(OUT, { stopWhen, audition: process.env.REWALK_SKIP_AUDITION !== '1',
    onUtterance: sayUtterance, onEvent: (e) => console.log(`[mic] ${e.kind} ${e.device ?? ''}`) })
    .catch((e) => { console.error(`REFUSING: ${e.message}`); process.exit(3) })
  console.log(`done: ${r.segs.length} segment(s), ${r.utterances.length} utterances streamed -> ${OUT}`)
}

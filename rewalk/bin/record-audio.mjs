// rewalk record-audio — the voice companion, decoupled from the browser.
//
// The extension cannot record the microphone: a capturer buried in Chrome's
// process tree is never attributed to our bundle by macOS TCC, so it gets
// zeroed buffers and no prompt (measured). The fix is not to fight the
// attribution but to sidestep it: record voice in a separate process the user
// launches themselves, which is its own responsible process, prompts normally,
// and holds its own grant. The extension records the DOM; this records the
// voice; bin/sync.mjs joins them by wall clock afterward. Same machine, same
// Date.now, so the join needs no beacon.
//
//   node bin/record-audio.mjs [outDir]     records until <outDir>/STOP appears
import fs from 'node:fs'
import path from 'node:path'
import { BundleMic, bundleAvailable } from '../lib/mac/bundle-mic.mjs'
import { Mic } from '../lib/mic.mjs'
import { fitProgressClock } from '../lib/record.mjs'

const OUT = process.argv[2] ?? `out/audio-${Date.now()}`
fs.mkdirSync(OUT, { recursive: true })
const audit = process.env.REWALK_SKIP_AUDITION !== '1'

// Prefer the bundle (own TCC identity), fall back to ffmpeg. Either way this
// runs in a process the user started, so it inherits a real grant.
let mic
try {
  mic = bundleAvailable()
    ? await new BundleMic(OUT, { onEvent: (e) => console.log(`[mic] ${e.kind} ${e.device ?? ''}`) }).startAsync({ audition: audit })
    : new Mic(OUT, { onEvent: (e) => console.log(`[mic] ${e.kind} ${e.device ?? ''}`) }).start({ audition: audit })
} catch (e) {
  console.error(`\nREFUSING TO RECORD: ${e.message}`)
  if (e.stats) console.error(`  ${JSON.stringify(e.stats)}`)
  console.error(`  Fix it and run again, or REWALK_SKIP_AUDITION=1 to record anyway.`)
  process.exit(3)
}

const startedWall = Date.now()
fs.writeFileSync(path.join(OUT, 'audio-meta.json'), JSON.stringify({ startedWall, kind: 'rewalk-audio-companion' }, null, 1))
console.log(`recording voice -> ${OUT}`)
console.log(`stop with: touch ${OUT}/STOP`)

while (!fs.existsSync(path.join(OUT, 'STOP'))) await new Promise((r) => setTimeout(r, 400))

const segs = await mic.stop()
const clocks = mic.segments.map((s) => {
  const f = fitProgressClock(s.ticks)
  return { file: path.basename(s.file), device: s.device?.name, ...(f.ok ? f : { ok: false, reason: f.reason }), toWall: undefined }
})
fs.writeFileSync(path.join(OUT, 'audio-meta.json'), JSON.stringify(
  { startedWall, endedWall: Date.now(), kind: 'rewalk-audio-companion', mic: segs, audioClocks: clocks }, null, 1))
for (const c of clocks) console.log(c.ok
  ? `audio clock ${c.file}: sample 0 at ${new Date(c.startWall).toISOString()}, drift ${c.driftPpm}ppm, residual ${c.residualMs}ms (${c.ticks} ticks)`
  : `audio clock ${c.file}: ${c.reason}`)
const mb = segs.reduce((n, s) => n + s.bytes, 0) / 1024 / 1024
console.log(`done: ${segs.length} audio segment(s), ${mb.toFixed(1)}MB`)

// rewalk session — one command for a paired recording in your real Chrome.
//
// Owns a single session directory and runs the voice companion into it. While
// it runs, clicking the rewalk button in Chrome makes the extension host
// co-locate its DOM stream in the SAME directory (via out/.rewalk-current), so
// voice and DOM land together and there is no separate sync step. On stop it
// merges the two sides' metadata into one session.json and reads it back.
//
//   node bin/session.mjs [outDir]                 live: companion + extension
//   node bin/session.mjs [outDir] --from-wav <p>  test: replay a wav for voice
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { readStream } from '../lib/deltas.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : `out/session-${Date.now()}`
const absOut = path.resolve(ROOT, OUT)
fs.mkdirSync(absOut, { recursive: true })
const ptr = path.join(ROOT, 'out', '.rewalk-current')

// Announce the session so the extension host co-locates its DOM here.
const startedWall = Date.now()
fs.writeFileSync(ptr, JSON.stringify({ dir: absOut, startedWall, active: true }, null, 1))
const clearPtr = () => { try { fs.writeFileSync(ptr, JSON.stringify({ dir: absOut, startedWall, active: false }, null, 1)) } catch (e) {} }

const rest = process.argv.slice(3)
const voice = spawn(process.execPath, [path.join(ROOT, 'bin/stream-audio.mjs'), absOut, ...rest], { stdio: 'inherit' })

console.log(`\nrewalk session -> ${OUT}`)
console.log(`  1. click the rewalk button in Chrome to start recording the tab`)
console.log(`  2. use the page and talk; ⌥-click what you mean`)
console.log(`  3. when done: click the rewalk button again, then  touch ${OUT}/STOP\n`)

// Voice companion stops on the STOP file (stream-audio watches it too). Wait for
// it to exit, then give the extension host a moment to finalize its session.json.
await new Promise((resolve) => voice.on('exit', resolve))
clearPtr()
await new Promise((r) => setTimeout(r, 1500))

// --- merge the two sides into one session.json ----------------------------
const audioMeta = readJson(path.join(absOut, 'audio-meta.json')) ?? {}
const hostMeta = readJson(path.join(absOut, 'session.json')) ?? {}
let url = hostMeta.url ?? null
const eventsPath = path.join(absOut, 'events.ndjson')
let events = 0
if (fs.existsSync(eventsPath)) {
  const ev = readStream(fs.readFileSync(eventsPath, 'utf8'))
  events = ev.length
  if (!url) { const meta = ev.find((e) => e.type === 4); url = meta?.data?.href ?? null }
}
const merged = { url, via: 'session', browserReadyWall: hostMeta.browserReadyWall ?? startedWall,
  endedWall: Date.now(), events, mic: audioMeta.mic ?? [], audioClocks: audioMeta.audioClocks ?? [],
  utterances: audioMeta.utterances ?? 0, streamed: !!audioMeta.streamed }
fs.writeFileSync(path.join(absOut, 'session.json'), JSON.stringify(merged, null, 1))

console.log(`\nsession: ${events} DOM events, ${merged.utterances} utterances, ${merged.audioClocks.length} audio clock(s)`)
if (!events) console.log(`  (no DOM — did you click the rewalk button in Chrome?)`)

// --- read it back ---------------------------------------------------------
if (events && (merged.utterances || merged.audioClocks.length)) {
  console.log(`\nreading back:\n`)
  const r = spawn(process.execPath, [path.join(ROOT, 'bin/read.mjs'), absOut], { stdio: 'inherit' })
  r.on('exit', (c) => process.exit(c ?? 0))
} else {
  console.log(`\nnothing to resolve yet. Both halves must record: ${OUT}`)
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }

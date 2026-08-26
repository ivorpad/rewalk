// rewalk session — one command for a paired recording in your real Chrome.
//
// Owns a single session directory and runs the voice companion into it. While
// it runs, clicking the rewalk button in Chrome makes the extension host
// co-locate its DOM stream in the SAME directory (via out/.rewalk-current), so
// voice and DOM land together and there is no separate sync step. On stop it
// merges the two sides' metadata into one session.json, reads it back, and
// opens the replay (lib/finish.mjs, shared with the login daemon).
//
//   node bin/session.mjs [outDir]                 live: companion + extension
//   node bin/session.mjs [outDir] --from-wav <p>  test: replay a wav for voice
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { finishSession } from '../lib/finish.mjs'
import { PRODUCT_ROOT, sessionsDir } from '../lib/config.mjs'

const ROOT = PRODUCT_ROOT
const OUT = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : path.join(sessionsDir(), `session-${Date.now()}`)
const absOut = path.isAbsolute(OUT) ? OUT : path.resolve(ROOT, OUT)
fs.mkdirSync(absOut, { recursive: true })
const ptr = path.join(sessionsDir(), '.rewalk-current')

// Announce the session so the extension host co-locates its DOM here.
const startedWall = Date.now()
fs.writeFileSync(ptr, JSON.stringify({ dir: absOut, startedWall, active: true }, null, 1))
const clearPtr = () => { try { fs.writeFileSync(ptr, JSON.stringify({ dir: absOut, startedWall, active: false }, null, 1)) } catch (e) {} }

const rest = process.argv.slice(3)
const voice = spawn(process.execPath, [path.join(ROOT, 'bin/stream-audio.mjs'), absOut, ...rest], { stdio: 'inherit' })

console.log(`\nrewalk session -> ${OUT}`)
console.log(`  1. click the rewalk button in Chrome to start recording the tab`)
console.log(`  2. use the page and talk; ⌥-click what you mean`)
console.log(`  3. when done: click the rewalk button again — everything stops and the replay opens\n`)

// The companion stops when the extension host finalizes in this dir (the stop
// click closes the native port) or on the STOP-file fallback. Wait for it to
// exit, then give the host a moment in case STOP-file came first.
await new Promise((resolve) => voice.on('exit', resolve))
clearPtr()
await new Promise((r) => setTimeout(r, 1500))

console.log()
await finishSession(absOut, { startedWall, open: true })

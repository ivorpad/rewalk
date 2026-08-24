// rewalk daemon — voice for the button-only flow, launched at login.
//
// The browser cannot own the microphone on macOS (TCC attributes a capturer in
// Chrome's process tree to nobody: no prompt, zeroed buffers), so a process the
// user launched must hold the grant. This daemon holds it without a terminal.
// It auditions the mic bundle once at startup, then waits for the extension
// host to ask for voice. The ask is a file, not a socket — out/.rewalk-voice,
// written by the host when it starts a recording with no companion attached;
// the stop signal is the same one the companion listens for, the host's
// finalized session.json. When voice lands, the session finishes exactly like
// `rewalk session` (merge, read, replay) and a notification opens the replay.
//
//   node bin/daemon.mjs      run in a terminal (testing)
//   sh daemon/install.sh     LaunchAgent, runs at login (the real thing)
import fs from 'node:fs'
import path from 'node:path'
import path0 from 'node:path'
// launchd (like Chrome) starts us with a minimal PATH; ffprobe and
// terminal-notifier live in Homebrew's dir. Same fix shape as the native host.
process.env.PATH = [path0.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin',
  process.env.PATH || '', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':')

import { recordVoice, hostFinalized } from '../lib/voice.mjs'
import { finishSession } from '../lib/finish.mjs'
import { auditionBundle } from '../lib/mac/bundle-mic.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const REQ = path.join(ROOT, 'out', '.rewalk-voice')
const LOCK = path.join(ROOT, 'out', '.rewalk-daemon.pid')
const log = (m) => console.log(`${new Date().toISOString()} ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }

fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true })

// One daemon at a time: a second instance would double-capture the device.
const prev = Number(readJson(LOCK)?.pid)
if (prev && isAlive(prev)) { log(`another daemon is running (pid ${prev}); exiting`); process.exit(0) }
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedWall: Date.now() }))

// Audition once at startup so a dead device is refused loudly now, and each
// session can start without the 3s gate — otherwise the first words after the
// button click are lost. If the audition fails (device busy at login), do not
// die: KeepAlive would relaunch-loop us against the mic. Gate per-session.
const a = await auditionBundle()
if (!a.ok) log(`startup audition failed (${a.reason}); will audition per session instead`)
log(`daemon up (pid ${process.pid})${a.ok ? '; mic auditioned ok' : ''}`)

let handled = 0
while (true) {
  await sleep(250)
  const req = readJson(REQ)
  if (!req?.active || !req.dir || (req.startedWall ?? 0) <= handled) continue
  handled = req.startedWall
  if (Date.now() - req.startedWall > 15_000) { log(`ignoring stale voice request for ${req.dir}`); continue }
  if (!fs.existsSync(req.dir)) { log(`voice request for missing dir ${req.dir}`); continue }

  log(`voice -> ${req.dir}`)
  const stopWhen = () => hostFinalized(req.dir, req.startedWall)
    || fs.existsSync(path.join(req.dir, 'STOP'))
    || readJson(REQ)?.active === false
  try {
    const r = await recordVoice(req.dir, { stopWhen, audition: !a.ok,
      onUtterance: (u) => log(`  [+${(u.from / 1000).toFixed(1)}s] ${u.text}`),
      onEvent: (e) => log(`[mic] ${e.kind} ${e.device ?? ''}`) })
    log(`voice done: ${r.utterances.length} utterance(s)`)
  } catch (e) { log(`voice failed: ${e.message}`) }

  // Give the host a beat to flush, then finish the session whole — merge,
  // read, replay — even if voice failed: a DOM-only replay is still worth
  // the notification.
  await sleep(1500)
  try { await finishSession(req.dir, { startedWall: req.startedWall, notify: true, log }) }
  catch (e) { log(`finish failed: ${e.message}`) }
}

function isAlive(pid) { try { process.kill(pid, 0); return true } catch (e) { return false } }

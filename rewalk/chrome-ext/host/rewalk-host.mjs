#!/usr/bin/env node
// The native messaging host: watch.mjs with the browser half removed.
//
// Chrome spawns this on connectNative(). Instead of Playwright driving a
// Chromium and exposeBinding delivering batches, the batches arrive framed on
// stdin from the service worker. Everything downstream is the CLI's, unchanged:
// the append-only Sink (kill-safe, no write-at-exit), the Mic (same ffmpeg
// pipeline, audition gate, aresample fix), and the progress-tick clock fit. A
// session recorded through the extension is byte-compatible with one recorded
// through `watch`, so read/replay/locate/score do not know the difference.
//
// Framing (Chrome native messaging): 4-byte little-endian length + UTF-8 JSON,
// both directions. macOS is little-endian, so native order is LE.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import path0 from 'node:path'
// Chrome spawns native hosts with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
// ffmpeg/ffprobe live in Homebrew's dir, so every spawnSync('ffmpeg') inside
// lib/mic.mjs and lib/audio-device.mjs was ENOENT -- which surfaced as the
// avfoundation device list coming back EMPTY, so the CoreAudio default "was not
// in the list" no matter how many times we re-enumerated. Not a device race,
// not TCC: a PATH gap. Prepend node's own dir and the usual install locations
// so the tools resolve exactly as they do in a login shell. Same fix shape as
// baking node's path into the host wrapper.
process.env.PATH = [path0.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin',
  process.env.PATH || '', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':')

import { Sink, fitProgressClock } from '../../lib/record.mjs'
import { Mic } from '../../lib/mic.mjs'
import { BundleMic, bundleAvailable } from '../../lib/mac/bundle-mic.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
// Chrome gives the host no arguments, so it names its own session. Date.now is
// fine here -- this is a plain host process, not a replayable workflow.
// Co-locate with a companion session when one is live. `rewalk session` writes
// out/.rewalk-current pointing at the dir it owns; if that pointer is fresh and
// still active, the browser writes its DOM there so voice and DOM land in one
// directory and no sync step is needed. Otherwise the host owns its own dir.
function currentSessionDir() {
  try {
    const ptr = JSON.parse(fs.readFileSync(path.join(REPO, 'out', '.rewalk-current'), 'utf8'))
    if (ptr.active && ptr.dir && Date.now() - (ptr.startedWall ?? 0) < 3600_000 && fs.existsSync(ptr.dir)) return ptr.dir
  } catch (e) {}
  return null
}
const coLocated = currentSessionDir()
const OUT = coLocated ?? path.join(REPO, 'out', `ext-${Date.now()}`)
fs.mkdirSync(OUT, { recursive: true })
const log = (m) => { try { fs.appendFileSync(path.join(OUT, 'host.log'), `${new Date().toISOString()} ${m}\n`); } catch (e) {} }
log(`host start -> ${OUT}`)

// Voice is never ours (TCC, below). When no companion owns this dir, ask the
// login daemon (bin/daemon.mjs) to record voice into it. The ask is a file the
// daemon polls; if no daemon is running, nothing answers and the session is
// DOM-only, exactly as before.
const VOICE_REQ = path.join(REPO, 'out', '.rewalk-voice')
const voiceStartedWall = Date.now()
if (!coLocated) {
  try { fs.writeFileSync(VOICE_REQ, JSON.stringify({ dir: OUT, startedWall: voiceStartedWall, active: true }, null, 1)); log('voice requested from daemon') }
  catch (e) { log(`voice request failed: ${e.message}`) }
}

const sink = new Sink(OUT)
let url = null, t0 = Date.now(), events = 0

// --- mic ---------------------------------------------------------------------
// Off by default, on purpose. A capturer spawned inside Chrome's process tree
// is never attributed to our bundle by macOS TCC -- no prompt, zeroed buffers,
// measured twice. So the browser records DOM only and voice is recorded by the
// separate companion (bin/record-audio.mjs), which is its own responsible
// process and gets a real grant; bin/sync.mjs joins them by wall clock. Set
// REWALK_HOST_MIC=1 to attempt in-host capture anyway (it will fail on macOS,
// but the branch is kept for a platform where the host CAN hold a grant).
let mic = null, micDead = false, micReason = null
const wantMic = process.env.REWALK_HOST_MIC === '1'
const audit = process.env.REWALK_SKIP_AUDITION !== '1'
try {
  if (!wantMic) { micReason = 'by-design: browser records DOM only; run bin/record-audio.mjs for voice, then bin/sync.mjs'; throw { message: micReason, byDesign: true } }
  if (bundleAvailable()) {
    log('mic: bundled capturer (com.rewalk.mic)')
    mic = await new BundleMic(OUT, { onEvent: (e) => log(`[mic] ${e.kind} ${e.device ?? e.reason ?? ''}`) }).startAsync({ audition: audit })
  } else {
    log('mic: ffmpeg fallback (rewalk-mic.app not built)')
    mic = new Mic(OUT, { onEvent: (e) => log(`[mic] ${e.kind} ${e.device ?? e.reason ?? ''}`) }).start({ audition: audit })
  }
} catch (e) {
  if (e.byDesign) { micDead = true; log('mic: ' + micReason) }
  else {
  micDead = true
  let seen = []
  try { const { avfoundationInputs } = await import('../../lib/audio-device.mjs'); seen = avfoundationInputs() } catch (x) {}
  // Classify precisely, because the signature is shared but the fix is not. If
  // avfoundation enumerated devices (so ffmpeg runs, PATH is fine) yet the audio
  // is digitally silent, the microphone grant is being denied to THIS process --
  // the Chrome-spawned native host -- not to a terminal. macOS attributes TCC to
  // the responsible process; a bare node host has no Info.plist and no
  // NSMicrophoneUsageDescription, so it cannot even be prompted, and gets zeroed
  // buffers. That is measured, and it is the real limit of the extension's audio
  // branch until the capturer is something macOS can attribute and prompt for.
  const digitalSilence = /digitally silent|will not record usable speech/.test(e.message)
  micReason = (seen.length && digitalSilence)
    ? 'tcc-denied-native-host: avfoundation enumerated ' + seen.length + ' devices but capture was digitally silent — macOS denies the mic to the Chrome-spawned host (no Info.plist to prompt against)'
    : e.message
  log(`mic refused: ${micReason} | PATH=${process.env.PATH} | avfoundation=${JSON.stringify(seen)}`)
  }
}

// --- native messaging framing ---------------------------------------------
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length, 0)
  try { process.stdout.write(Buffer.concat([head, body])) } catch (e) {}
}

let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) break
    const msg = buf.subarray(4, 4 + len)
    buf = buf.subarray(4 + len)
    let m
    try { m = JSON.parse(msg.toString('utf8')) } catch (e) { continue }
    if (m.control === 'start' && m.url) { url = m.url; log(`bound ${url}`) }
    if (m.batch != null) {
      let arr
      try { arr = JSON.parse(m.batch) } catch (e) { continue }   // batch is a JSON string
      if (Array.isArray(arr) && arr.length) { sink.push(arr); events += arr.length }
    }
  }
})

// --- HUD reverse path: the RMS of what is actually on disk ------------------
// Identical honesty to watch.mjs -- the level is read from the wav ffmpeg wrote,
// so it cannot show green over a dead device.
function levelOf() {
  try {
    // Our own capture when we have one; otherwise the daemon's wav growing in
    // the same dir — still bytes on disk, so still unable to lie.
    const seg = mic && mic.segments[mic.segments.length - 1]
    const file = seg && !seg.endedWall ? seg.file : path.join(OUT, 'audio.1.wav')
    const size = fs.statSync(file).size
    const want = 8000
    if (size < 44 + want) return 0
    const fd = fs.openSync(file, 'r')
    const b = Buffer.alloc(want)
    fs.readSync(fd, b, 0, want, size - want - (size % 2))
    fs.closeSync(fd)
    let sum = 0
    for (let i = 0; i + 1 < want; i += 2) { const v = b.readInt16LE(i) / 32768; sum += v * v }
    return Math.sqrt(sum / (want / 2))
  } catch (e) { return 0 }
}
const hudTimer = setInterval(() => send({ hud: levelOf() }), 300)

// --- shutdown: Chrome closing the port ends stdin --------------------------
async function finalize() {
  clearInterval(hudTimer)
  let segs = []
  try { if (mic) segs = await mic.stop() } catch (e) { log(`mic stop: ${e.message}`) }
  const clocks = (mic ? mic.segments : []).map((s) => {
    const f = fitProgressClock(s.ticks)
    return { file: path.basename(s.file), device: s.device?.name, ...(f.ok ? f : { ok: false, reason: f.reason }), toWall: undefined }
  })
  sink.meta({ url, browserReadyWall: t0, endedWall: Date.now(), events: sink.n,
    mic: segs, micDead, micReason, audioClocks: clocks, via: 'extension' })
  sink.close()
  // session.json above is the daemon's stop signal; retiring the request too
  // covers the case where that write failed.
  if (!coLocated) { try { fs.writeFileSync(VOICE_REQ, JSON.stringify({ dir: OUT, startedWall: voiceStartedWall, active: false }, null, 1)) } catch (e) {} }
  log(`done: ${sink.n} events, ${segs.length} audio segment(s)`)
  process.exit(0)
}
process.stdin.on('end', finalize)
process.stdin.on('close', finalize)
process.on('SIGTERM', finalize)
process.on('SIGINT', finalize)

// Failsafe, same bound as lib/voice.mjs: the port close IS the stop signal,
// and when the service worker wedges nothing ever closes it. Measured
// 2026-08-25: one such session kept this host (and the daemon's mic behind
// it) alive for ~10 hours. No legitimate recording reaches the cap.
const MAX_MS = Number(process.env.REWALK_MAX_VOICE_MS) || 2 * 3600_000
setTimeout(() => { log(`failsafe: no stop signal after ${Math.round(MAX_MS / 60000)} minutes — finalizing`); finalize() }, MAX_MS).unref()

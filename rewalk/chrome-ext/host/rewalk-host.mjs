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
import { Sink, fitProgressClock } from '../../lib/record.mjs'
import { Mic } from '../../lib/mic.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
// Chrome gives the host no arguments, so it names its own session. Date.now is
// fine here -- this is a plain host process, not a replayable workflow.
const OUT = path.join(REPO, 'out', `ext-${Date.now()}`)
fs.mkdirSync(OUT, { recursive: true })
const log = (m) => { try { fs.appendFileSync(path.join(OUT, 'host.log'), `${new Date().toISOString()} ${m}\n`); } catch (e) {} }
log(`host start -> ${OUT}`)

const sink = new Sink(OUT)
let url = null, t0 = Date.now(), events = 0

// --- mic: same as watch, and it refuses the same unusable audio ------------
let mic = null, micDead = false
try {
  mic = new Mic(OUT, { onEvent: (e) => log(`[mic] ${e.kind} ${e.device ?? e.reason ?? ''}`) })
    .start({ audition: process.env.REWALK_SKIP_AUDITION !== '1' })
} catch (e) {
  micDead = true
  log(`mic refused: ${e.message}`)   // DOM still records; the HUD will show red
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
    const seg = mic && mic.segments[mic.segments.length - 1]
    if (!seg || seg.endedWall) return micDead ? 0 : 0
    const size = fs.statSync(seg.file).size
    const want = 8000
    if (size < 44 + want) return 0
    const fd = fs.openSync(seg.file, 'r')
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
    mic: segs, micDead, audioClocks: clocks, via: 'extension' })
  sink.close()
  log(`done: ${sink.n} events, ${segs.length} audio segment(s)`)
  process.exit(0)
}
process.stdin.on('end', finalize)
process.stdin.on('close', finalize)
process.on('SIGTERM', finalize)
process.on('SIGINT', finalize)

#!/usr/bin/env node
// capture-host.mjs — native messaging host for the Risk-3 TCC probe.
//
// Chrome spawns this on connectNative('com.rewalk.probe'). On {cmd:"capture"}
// it runs ffmpeg avfoundation for 2s against the *system default* microphone
// (resolved through lib/audio-device.mjs defaultMicSpec, exactly as the real
// recorder does), reads the raw PCM back, and reports:
//
//   peak         — largest |sample| (0..32768)
//   nonZero      — count of non-zero samples
//   total        — total samples
//
// The verdict rule (from FINDINGS/notes): all-zero samples == TCC DENIED.
// macOS hands a denied process zeroed buffers instead of failing the open, so
// "ffmpeg succeeded" is not evidence of a grant — the samples are. Non-zero
// == the host inherited a usable microphone grant from whatever Chrome's TCC
// identity is.
//
// It replies on the port AND writes result.json next to this file, so the
// verdict survives even if the service worker is torn down or Chrome discards
// the host's stderr.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defaultMicSpec } from '../../lib/audio-device.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RESULT = path.join(HERE, 'result.json')
const LOG = path.join(HERE, 'capture-host.log')
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg'
const LE = os.endianness() === 'LE'

function log(...a) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${a.join(' ')}\n`) } catch (e) {}
}

// --- who spawned us? document the process chain for attribution -------------
function procChain() {
  const chain = []
  let pid = process.pid
  for (let i = 0; i < 8 && pid && pid > 1; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' })
    const line = (r.stdout || '').trim()
    if (!line) break
    const sp = line.indexOf(' ')
    const ppid = parseInt(line.slice(0, sp), 10)
    const comm = line.slice(sp + 1).trim()
    chain.push({ pid, comm })
    pid = ppid
  }
  return chain
}

function readFrame(fd) { /* not used; we read stdin via events */ }

function writeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const len = Buffer.allocUnsafe(4)
  if (LE) len.writeUInt32LE(body.length, 0); else len.writeUInt32BE(body.length, 0)
  process.stdout.write(Buffer.concat([len, body]))
}

function capture() {
  const started = Date.now()
  let mic
  try { mic = defaultMicSpec() } catch (e) { mic = { ok: false, reason: `defaultMicSpec threw: ${e.message}` } }
  log('defaultMicSpec:', JSON.stringify(mic))
  if (!mic.ok) return { ok: false, reason: `no default mic: ${mic.reason}`, mic }

  const raw = path.join(os.tmpdir(), `rewalk-tcc-probe-${process.pid}.s16le`)
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', mic.spec,
    '-t', '2', '-ac', '1', '-ar', '16000', '-f', 's16le', '-y', raw]
  log('ffmpeg', FFMPEG, args.join(' '))
  const r = spawnSync(FFMPEG, args, { encoding: 'buffer' })
  const ffStderr = (r.stderr ? r.stderr.toString('utf8') : '').slice(-500)
  if (r.status !== 0 && !fs.existsSync(raw)) {
    log('ffmpeg failed status', r.status, ffStderr)
    return { ok: false, reason: `ffmpeg exit ${r.status}`, ffmpegStderr: ffStderr, mic, ffmpegPath: FFMPEG }
  }

  let buf
  try { buf = fs.readFileSync(raw) } catch (e) { return { ok: false, reason: `unreadable capture: ${e.message}`, mic } }
  finally { try { fs.unlinkSync(raw) } catch (e) {} }

  let peak = 0, nonZero = 0
  const total = Math.floor(buf.length / 2)
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = buf.readInt16LE(i)
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
    if (v !== 0) nonZero += 1
  }
  const captureMs = Date.now() - started
  // The whole point: zeros == denied (macOS hands zeroed buffers to a denied
  // process), non-zero == a real grant was inherited.
  const tccVerdict = nonZero === 0 ? 'DENIED (all-zero samples — macOS zeroed buffers)'
    : 'GRANTED (non-zero samples — usable mic access inherited)'
  return {
    ok: true, tccVerdict,
    peak, nonZero, total, peakNormalized: +(peak / 32768).toFixed(6),
    captureMs, bytesCaptured: buf.length,
    device: mic.name, spec: mic.spec,
    ffmpegStderr: ffStderr || null, ffmpegPath: FFMPEG,
  }
}

// --- native messaging read loop ---------------------------------------------
log('host started pid', process.pid, 'uid', process.getuid?.())
const chain = procChain()
log('process chain:', JSON.stringify(chain))

let acc = Buffer.alloc(0)
let handled = false
process.stdin.on('data', (chunk) => {
  acc = acc.length ? Buffer.concat([acc, chunk]) : chunk
  for (;;) {
    if (acc.length < 4) break
    const len = LE ? acc.readUInt32LE(0) : acc.readUInt32BE(0)
    if (acc.length < 4 + len) break
    const body = acc.subarray(4, 4 + len)
    acc = acc.subarray(4 + len)
    let msg
    try { msg = JSON.parse(body.toString('utf8')) } catch (e) { log('bad json', e.message); continue }
    log('recv', JSON.stringify(msg))
    if (msg && msg.cmd === 'capture' && !handled) {
      handled = true
      const result = { ...capture(), procChain: chain, hostPid: process.pid, hostPpid: process.ppid, at: Date.now() }
      try { fs.writeFileSync(RESULT, JSON.stringify(result, null, 2)) } catch (e) { log('write result failed', e.message) }
      log('result', JSON.stringify(result))
      writeFrame(result)
      // Give stdout a moment to flush, then exit cleanly (closes the port).
      setTimeout(() => process.exit(0), 300)
    }
  }
})
process.stdin.on('end', () => { log('stdin end'); setTimeout(() => process.exit(0), 100) })
process.on('uncaughtException', (e) => { log('uncaught', e.stack || e.message) })

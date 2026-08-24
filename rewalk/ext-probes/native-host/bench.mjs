#!/usr/bin/env node
// bench.mjs — drive host.mjs with synthetic rrweb traffic, no Chrome.
//
// Risk-2 experiment (notes/extension-route.md §4.2). Chrome is deliberately
// out of the loop here: this measures the pipe + host, the part that has no
// documented rate limit and that the SW hop would only add latency on top of.
// If the raw stdin path can't sustain the load, the extension route is dead
// regardless of Chrome; if it can, this is the floor.
//
// Load profile:
//   - Sustained 1 MB/s for 30s: a 256 KiB batch every 250ms (rewalk's real
//     batch cadence), so 4 batches/s * 256 KiB = 1 MB/s, ~120 batches, ~30 MB.
//   - One 3 MB burst: a single batch carrying a dozen ~271 KB events (the worst
//     real event line measured in out/ledger-01) sent as one frame, to exercise
//     the large-message path well under the 64 MiB extension->host limit.
//
// Measures: end-to-end ack latency p50/p95, whether child.stdin ever applied
// backpressure (write() -> false) and for how long, bytes-on-disk vs
// bytes-sent (must match exactly), and peak host RSS via ps.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST = path.join(HERE, 'host.mjs')
const OUT = path.join(os.tmpdir(), `rewalk-probe-host-${process.pid}.ndjson`)
const LE = os.endianness() === 'LE'

const SUSTAIN_MS = 30_000
const BATCH_MS = 250
const BATCH_BYTES = 256 * 1024 // -> 1 MB/s at 4 batches/s
const BIG_EVENT_BYTES = 271 * 1024 // worst real event line, out/ledger-01
const BURST_EVENTS = 11 // ~11 * 271 KB ~= 3 MB

// ---- synthetic rrweb-shaped payloads ---------------------------------------
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ .,'
function filler(n) {
  if (n <= 0) return ''
  let s = ALPHA
  while (s.length < n) s += s
  return s.slice(0, n)
}
// A batch is {seq, events:[...]}: a run of incremental mousemove/scroll events
// plus one padded node blob so the serialized size lands on target. Content is
// irrelevant to a pipe (no compression), size is not.
function makeBatch(seq, targetBytes) {
  const t = seq * BATCH_MS
  const events = []
  for (let i = 0; i < 12; i++) {
    events.push({ type: 3, data: { source: i % 2 ? 3 : 1, positions: [{ x: (i * 37) % 1280, y: (i * 53) % 800, id: 100 + i, timeOffset: -i }] }, timestamp: t + i })
  }
  const head = JSON.stringify({ seq, events }).length
  events.push({ type: 3, data: { source: 9, id: 42, styleId: 1, node: filler(Math.max(0, targetBytes - head - 120)) }, timestamp: t + 20 })
  return { seq, events }
}
function makeBurst(seq) {
  const events = []
  for (let i = 0; i < BURST_EVENTS; i++) {
    events.push({ type: 2, data: { node: filler(BIG_EVENT_BYTES), initialOffset: { top: 0, left: 0 } }, timestamp: seq * BATCH_MS + i })
  }
  return { seq, events }
}
function frame(payload) {
  const len = Buffer.allocUnsafe(4)
  if (LE) len.writeUInt32LE(payload.length, 0)
  else len.writeUInt32BE(payload.length, 0)
  return Buffer.concat([len, payload])
}

// ---- host + measurement -----------------------------------------------------
const child = spawn(process.execPath, [HOST], { env: { ...process.env, PROBE_OUT: OUT }, stdio: ['pipe', 'pipe', 'pipe'] })
let hostSummary = null
child.stderr.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue
    try { const o = JSON.parse(line); if (o.done) hostSummary = o } catch (e) { process.stderr.write(`[host] ${line}\n`) }
  }
})

const sendAt = new Map() // seq -> hrtime ns when frame handed to child.stdin
const latencies = [] // ms, per ack
let acked = 0
let ackBuf = Buffer.alloc(0)
child.stdout.on('data', (chunk) => {
  ackBuf = ackBuf.length ? Buffer.concat([ackBuf, chunk]) : chunk
  for (;;) {
    if (ackBuf.length < 4) break
    const len = LE ? ackBuf.readUInt32LE(0) : ackBuf.readUInt32BE(0)
    if (ackBuf.length < 4 + len) break
    const body = ackBuf.subarray(4, 4 + len)
    ackBuf = ackBuf.subarray(4 + len)
    let ack
    try { ack = JSON.parse(body.toString('utf8')) } catch (e) { continue }
    const t0 = sendAt.get(ack.msgSeq)
    if (t0 != null) {
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6)
      sendAt.delete(ack.msgSeq)
    }
    acked += 1
  }
})

// Peak RSS sampling via ps (RSS is in KiB on macOS).
let peakRssKb = 0
const rssTimer = setInterval(() => {
  const r = spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' })
  const kb = parseInt((r.stdout || '').trim(), 10)
  if (Number.isFinite(kb)) peakRssKb = Math.max(peakRssKb, kb)
}, 250)

// Backpressure accounting: write() returning false means the kernel/stream
// buffer is full and the writer would stall until 'drain'.
let backpressureEvents = 0
let backpressureMs = 0
function writeFrame(buf) {
  return new Promise((resolve) => {
    const ok = child.stdin.write(buf)
    if (ok) return resolve()
    backpressureEvents += 1
    const t0 = process.hrtime.bigint()
    child.stdin.once('drain', () => {
      backpressureMs += Number(process.hrtime.bigint() - t0) / 1e6
      resolve()
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let seq = 0
let bytesSent = 0 // payload bytes only (what the host writes to disk, + one \n each)
let framesSent = 0

async function sustained() {
  const start = process.hrtime.bigint()
  let next = 0
  while (true) {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    if (elapsedMs >= SUSTAIN_MS) break
    // pace to the batch grid so we hold ~1 MB/s regardless of write cost
    const targetMs = next * BATCH_MS
    if (elapsedMs < targetMs) { await sleep(targetMs - elapsedMs); }
    seq += 1; next += 1
    const payload = Buffer.from(JSON.stringify(makeBatch(seq, BATCH_BYTES)), 'utf8')
    bytesSent += payload.length + 1
    framesSent += 1
    sendAt.set(seq, process.hrtime.bigint())
    await writeFrame(frame(payload))
  }
}

async function burst() {
  seq += 1
  const payload = Buffer.from(JSON.stringify(makeBurst(seq)), 'utf8')
  bytesSent += payload.length + 1
  framesSent += 1
  sendAt.set(seq, process.hrtime.bigint())
  await writeFrame(frame(payload))
  return payload.length
}

function pctl(arr, p) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3)
}

console.log(`[bench] sustaining ${(BATCH_BYTES / 1024).toFixed(0)} KiB every ${BATCH_MS}ms for ${SUSTAIN_MS / 1000}s ...`)
const wallStart = process.hrtime.bigint()
await sustained()
console.log(`[bench] sustained done: ${framesSent} batches, ${(bytesSent / 1e6).toFixed(2)} MB payload`)
console.log(`[bench] sending one ${(BURST_EVENTS * BIG_EVENT_BYTES / 1024 / 1024).toFixed(1)} MB burst (${BURST_EVENTS} x ${(BIG_EVENT_BYTES / 1024).toFixed(0)} KiB events) ...`)
const burstBytes = await burst()
const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6

// Drain acks, then close stdin and let the host flush + summarize.
const deadline = Date.now() + 5000
while (acked < framesSent && Date.now() < deadline) await sleep(20)
child.stdin.end()
await new Promise((r) => { child.on('close', r); setTimeout(r, 5000) })
clearInterval(rssTimer)

const diskSize = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0
const report = {
  node: process.version,
  load: {
    sustainSeconds: SUSTAIN_MS / 1000,
    batchBytes: BATCH_BYTES,
    batchIntervalMs: BATCH_MS,
    targetRateMBs: (BATCH_BYTES / 1024 / (BATCH_MS / 1000) / 1024).toFixed(2),
    burstBytes,
    burstEventBytes: BIG_EVENT_BYTES,
  },
  result: {
    framesSent,
    acked,
    wallMs: +wallMs.toFixed(1),
    effectiveRateMBs: +((bytesSent / 1e6) / (wallMs / 1000)).toFixed(3),
    latencyMs: { p50: pctl(latencies, 0.5), p95: pctl(latencies, 0.95), max: latencies.length ? +Math.max(...latencies).toFixed(3) : null, samples: latencies.length },
    backpressureEvents,
    backpressureMs: +backpressureMs.toFixed(3),
    bytesSent,
    bytesOnDisk: diskSize,
    hostReportedBytesOnDisk: hostSummary?.bytesOnDisk ?? null,
    bytesMatch: diskSize === bytesSent,
    peakHostRssMB: +(peakRssKb / 1024).toFixed(1),
    hostFinalRssMB: hostSummary ? +(hostSummary.rss / 1024 / 1024).toFixed(1) : null,
  },
}
console.log(JSON.stringify(report, null, 2))
try { fs.unlinkSync(OUT) } catch (e) {}
process.exit(report.result.bytesMatch && acked === framesSent ? 0 : 1)

#!/usr/bin/env node
// host.mjs — native-messaging host stand-in for rewalk's recorder Sink.
//
// Risk-2 probe (notes/extension-route.md §4.2). This is what Chrome spawns on
// connectNative(). It reads the native-messaging wire on stdin — a 4-byte
// native-byte-order length prefix followed by that many UTF-8 JSON bytes — and
// for each message it:
//
//   1. parses the payload (the real host has to deserialize to reach the events
//      array, so the parse cost is measured, not skipped), and
//   2. appends the exact received payload bytes to an NDJSON file as one line,
//      with a single writeSync per batch.
//
// (2) is the same append-per-batch, no-flush-at-exit discipline as lib/record.mjs
// Sink: a kill -9 costs at most the frame in flight. Writing the *raw received
// bytes* (rather than re-serializing per event) is deliberate — it makes
// bytes-on-disk reconcilable against bytes-sent to the byte, which is the
// integrity half of this experiment. It is byte-volume-equivalent to Sink's
// per-event lines within noise (a batch wrapper vs inter-event newlines).
//
// It replies with a framed {seq, bytes} ack so the driver can measure
// round-trip latency and confirm nothing was dropped.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OUT = process.env.PROBE_OUT ?? path.join(os.tmpdir(), 'rewalk-probe-host.ndjson')
const LE = os.endianness() === 'LE'
const NL = Buffer.from('\n')

fs.rmSync(OUT, { force: true })
const fd = fs.openSync(OUT, 'a')

let seq = 0
let bytesOnDisk = 0

function writeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const len = Buffer.allocUnsafe(4)
  if (LE) len.writeUInt32LE(body.length, 0)
  else len.writeUInt32BE(body.length, 0)
  process.stdout.write(Buffer.concat([len, body]))
}

let acc = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  acc = acc.length ? Buffer.concat([acc, chunk]) : chunk
  for (;;) {
    if (acc.length < 4) break
    const len = LE ? acc.readUInt32LE(0) : acc.readUInt32BE(0)
    if (acc.length < 4 + len) break
    const payload = acc.subarray(4, 4 + len) // exact UTF-8 JSON bytes, as framed
    acc = acc.subarray(4 + len)

    // Realistic double-deserialize: the real host parses to reach batch.events.
    let msgSeq = null
    try { msgSeq = JSON.parse(payload.toString('utf8')).seq ?? null } catch (e) { msgSeq = null }

    // One writeSync per batch — append-per-batch, exact bytes.
    const w = fs.writeSync(fd, Buffer.concat([payload, NL]))
    bytesOnDisk += w
    seq += 1
    writeFrame({ seq, msgSeq, bytes: len })
  }
})

process.stdin.on('end', () => {
  try { fs.fsyncSync(fd) } catch (e) {}
  try { fs.closeSync(fd) } catch (e) {}
  // Emit a final summary line on stderr for the driver to reconcile against.
  process.stderr.write(JSON.stringify({ done: true, seq, bytesOnDisk, out: OUT, rss: process.memoryUsage().rss }) + '\n')
  process.exit(0)
})

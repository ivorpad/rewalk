#!/usr/bin/env node
// selftest.mjs — drive capture-host.mjs the way the extension would, but from
// this terminal instead of Chrome. This validates the host end-to-end and
// gives the *terminal-identity* TCC baseline (NOT the Chrome-spawned answer the
// probe is really about — that needs the manifest installed and Chrome to
// launch it). Frames one {cmd:"capture"} message in, reads the framed reply.

import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST = path.join(HERE, 'capture-host.mjs')
const LE = os.endianness() === 'LE'

const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', (d) => process.stderr.write(`[host stderr] ${d}`))

let acc = Buffer.alloc(0)
child.stdout.on('data', (chunk) => {
  acc = acc.length ? Buffer.concat([acc, chunk]) : chunk
  for (;;) {
    if (acc.length < 4) break
    const len = LE ? acc.readUInt32LE(0) : acc.readUInt32BE(0)
    if (acc.length < 4 + len) break
    const body = acc.subarray(4, 4 + len); acc = acc.subarray(4 + len)
    console.log('REPLY:', JSON.stringify(JSON.parse(body.toString('utf8')), null, 2))
  }
})
child.on('close', (c) => { console.log('[host exited]', c); process.exit(0) })

const payload = Buffer.from(JSON.stringify({ cmd: 'capture', trigger: 'selftest' }), 'utf8')
const len = Buffer.allocUnsafe(4)
if (LE) len.writeUInt32LE(payload.length, 0); else len.writeUInt32BE(payload.length, 0)
child.stdin.write(Buffer.concat([len, payload]))

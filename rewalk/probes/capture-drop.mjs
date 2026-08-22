// Why is the capture losing 10.5% of its samples, and what stops it?
//
// FINDINGS.md recorded the loss and named the first suspect: auditionMic()
// holds the same device for four seconds and closes it immediately before the
// real capture opens. Measured here, that is wrong -- a cold capture with no
// audition before it loses just as much (12.1% cold, 10.7% after an audition,
// 20.1% after an audition plus a settle delay). The hypothesis is dead and the
// settle delay it implied would have been cargo cult.
//
// The cause is the resampler. avfoundation delivers fewer samples than wall
// time says have elapsed, and by default ffmpeg writes exactly what it gets, so
// the file falls behind real time and every position in it maps to a wall time
// that is too early -- by a margin that grows all session, which reads as a
// person anticipating rather than as a bug. `aresample=async=1` fills the gaps
// instead, holding file position equal to elapsed time. Measured: 10.8% lost
// without it, 0.0% with it.
//
// Rate and channel count are NOT involved: native 48k stereo loses 11.3% and
// native-rate mono 11.5%, so this is not the 48k->16k conversion.
//
//   node probes/capture-drop.mjs [seconds]

import fs from 'node:fs'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { defaultMicSpec } from '../lib/audio-device.mjs'
import { readPcm } from '../lib/align.mjs'

const SECS = Number(process.argv[2] ?? 20)
const mic = defaultMicSpec()
if (!mic.ok) { console.error(`no usable microphone: ${mic.reason}`); process.exit(2) }
console.log(`device ${mic.name} (${mic.spec}), ${SECS}s per condition\n`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Hold the device for 4s and close it, exactly as auditionMic does. */
function audition() {
  const tmp = `${os.tmpdir()}/capture-drop-audition.wav`
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
    '-i', mic.spec, '-ac', '1', '-ar', '16000', '-t', '4', '-y', tmp], { encoding: 'utf8' })
  try { fs.unlinkSync(tmp) } catch (e) {}
}

async function capture(label, { pre = false, settleMs = 0, args = [] } = {}) {
  if (pre) audition()
  if (settleMs) await sleep(settleMs)
  const wav = `${os.tmpdir()}/capture-drop-${label.replace(/\W+/g, '-')}.wav`
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
    '-i', mic.spec, ...args, '-ac', '1', '-ar', '16000', '-y', wav,
    '-progress', 'pipe:1', '-stats_period', '0.25'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const t0 = Date.now()
  let buf = '', lastReported = 0
  p.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const l of lines) {
      const m = /^out_time_us=(\d+)/.exec(l.trim())
      if (m) lastReported = Number(m[1]) / 1000
    }
  })
  await sleep(SECS * 1000)
  await new Promise((r) => { p.once('close', r); p.kill('SIGINT'); setTimeout(r, 3000) })
  const wallMs = Date.now() - t0
  const { samples, sampleRate } = readPcm(wav)
  const fileMs = (samples.length / sampleRate) * 1000
  try { fs.unlinkSync(wav) } catch (e) {}
  // ffmpeg's own out_time is what the clock fit trusts; the file is the truth.
  const drop = 1 - fileMs / lastReported
  return { label, wallMs, fileMs, reportedMs: lastReported, drop }
}

const ASYNC = ['-af', 'aresample=async=1:min_hard_comp=0.100']
const rows = []
rows.push(await capture('cold, as shipped before', { args: [] }))
rows.push(await capture('after an audition', { pre: true, args: [] }))
rows.push(await capture('cold, aresample=async', { args: ASYNC }))
rows.push(await capture('after an audition, async', { pre: true, args: ASYNC }))

console.log(`${'condition'.padEnd(26)} ${'ffmpeg says'.padStart(12)} ${'file holds'.padStart(11)} ${'lost'.padStart(7)}`)
for (const r of rows)
  console.log(`${r.label.padEnd(26)} ${(r.reportedMs / 1000).toFixed(2).padStart(11)}s ${(r.fileMs / 1000).toFixed(2).padStart(10)}s ` +
    `${(r.drop * 100).toFixed(1).padStart(6)}%`)

const plain = rows.filter((r) => !r.label.includes('async'))
const async_ = rows.filter((r) => r.label.includes('async'))
const worstPlain = Math.max(...plain.map((r) => r.drop))
const worstAsync = Math.max(...async_.map((r) => Math.abs(r.drop)))
console.log()
if (worstPlain > 0.05 && worstAsync < 0.02)
  console.log(`aresample=async fixes it: up to ${(worstPlain * 100).toFixed(1)}% lost without it,` +
    ` at most ${(worstAsync * 100).toFixed(1)}% with it.\nThe audition is not involved -- the cold capture loses just as much.`)
else if (worstPlain < 0.02)
  console.log(`Nothing dropped this run. The loss is intermittent; re-run before concluding it is gone.`)
else
  console.log(`aresample did not close the gap this run — read the numbers above, not a verdict.`)

// Microphone capture that follows the system default device.
//
// Two requirements this exists to meet. Record whichever microphone the person
// actually selected, not a hardcoded index. And if they switch microphones mid
// session -- unplug a USB mic, put on a headset -- keep recording, from the new
// one, without losing what came before.
//
// A device change cannot be a seamless splice: the new device starts its own
// clock and there is a real gap while one stream stops and another starts. So a
// change closes the current segment and opens a new one. Each segment carries
// its own progress ticks and therefore its own clock fit, and the boundary is
// recorded rather than smoothed over, because pretending a gap did not happen
// is how an utterance lands against the wrong interaction.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { defaultMicSpec, watchDefaultInput } from './audio-device.mjs'

function ffmpegSegment(dir, spec, n) {
  const wav = path.join(dir, `audio.${n}.wav`)
  // -progress pairs a position in the audio with a position on the system
  // clock, repeatedly. That is what makes the audio clock measurable instead of
  // assumed, and unlike an acoustic beacon it needs no speakers -- which
  // matters when the microphone is nowhere near the machine.
  const args = ['-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-i', spec,
    '-ac', '1', '-ar', '16000', '-y', wav,
    '-progress', 'pipe:1', '-stats_period', '0.25']
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const seg = { file: wav, spec, startedWall: Date.now(), ticks: [], stderr: '' }
  let buf = ''
  proc.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      const m = /^out_time_us=(\d+)/.exec(l.trim())
      if (m) seg.ticks.push({ audioMs: Number(m[1]) / 1000, wall: Date.now() })
    }
  })
  proc.stderr.on('data', (d) => { seg.stderr += d })
  seg.proc = proc
  return seg
}

export class Mic {
  constructor(dir, { onEvent = () => {} } = {}) {
    this.dir = dir
    this.segments = []
    this.onEvent = onEvent
    this.stopWatch = null
    this.closed = false
  }

  start() {
    const mic = defaultMicSpec()
    if (!mic.ok) throw new Error(`no usable default microphone: ${mic.reason}`)
    this._open(mic)
    // Fires immediately with the current device, then on every change.
    let first = true
    this.stopWatch = watchDefaultInput((dev) => {
      if (first) { first = false; return }
      if (this.closed) return
      const next = defaultMicSpec()
      if (!next.ok) { this.onEvent({ kind: 'mic-lost', reason: next.reason, at: Date.now() }); return }
      if (next.uid === this.current?.uid) return
      this.onEvent({ kind: 'mic-changed', from: this.current?.name, to: next.name, at: Date.now() })
      this._close().then(() => { if (!this.closed) this._open(next) })
    })
    return this
  }

  _open(mic) {
    this.current = mic
    const seg = ffmpegSegment(this.dir, mic.spec, this.segments.length + 1)
    seg.device = { name: mic.name, uid: mic.uid, spec: mic.spec, inputChannels: mic.inputChannels }
    this.segments.push(seg)
    this.onEvent({ kind: 'mic-started', device: mic.name, spec: mic.spec, file: seg.file, at: seg.startedWall })
  }

  async _close() {
    const seg = this.segments[this.segments.length - 1]
    if (!seg || seg.endedWall) return
    seg.endedWall = Date.now()
    await new Promise((r) => {
      seg.proc.once('close', r)
      try { seg.proc.kill('SIGINT') } catch (e) {}
      setTimeout(r, 3000)
    })
  }

  async stop() {
    this.closed = true
    try { this.stopWatch?.() } catch (e) {}
    await this._close()
    return this.manifest()
  }

  manifest() {
    return this.segments.map((s) => ({
      file: path.basename(s.file), device: s.device,
      startedWall: s.startedWall, endedWall: s.endedWall ?? null,
      ticks: s.ticks.length,
      bytes: fs.existsSync(s.file) ? fs.statSync(s.file).size : 0,
      ffmpeg: s.stderr.slice(-300),
    }))
  }
}

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
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { defaultMicSpec, watchDefaultInput } from './audio-device.mjs'
import { readPcm } from './align.mjs'

/**
 * Refuse to record into a recording that cannot contain speech.
 *
 * Two sessions were lost this way -- three minutes and two minutes of a person
 * talking, transcribed afterwards as [Music] end to end, because a continuous
 * sound source at speech level was sitting in front of the microphone. The
 * check for it existed by the second one and simply was not run, so it now runs
 * where it cannot be skipped.
 *
 * The signature is loud AND flat. A quiet room is fine: low level with ordinary
 * ambient variation. What is never recoverable is a high floor that never dips,
 * because the gaps between phrases are where speech is legible.
 */
export function auditionMic(spec, seconds = 4) {
  const tmp = `${os.tmpdir()}/rewalk-audition-${process.pid}.wav`
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
    '-i', spec, '-ac', '1', '-ar', '16000', '-t', String(seconds), '-y', tmp], { encoding: 'utf8' })
  if (r.status !== 0) return { ok: false, reason: `ffmpeg could not open ${spec}: ${(r.stderr ?? '').slice(-200)}` }
  let pcm
  try { pcm = readPcm(tmp) } catch (e) { return { ok: false, reason: `unreadable capture: ${e.message}` } }
  finally { try { fs.unlinkSync(tmp) } catch (e) {} }
  const { samples, sampleRate } = pcm
  const win = Math.round(sampleRate * 0.05)
  const frames = []
  for (let i = 0; i + win < samples.length; i += win) {
    let s = 0
    for (let j = 0; j < win; j++) s += samples[i + j] ** 2
    frames.push(Math.sqrt(s / win))
  }
  if (!frames.length) return { ok: false, reason: 'no audio captured' }
  const sorted = [...frames].sort((x, y) => x - y)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const quiet = q(0.1), median = q(0.5), loud = q(0.95)
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  const dyn = quiet > 0 ? loud / quiet : (loud > 0 ? Infinity : 1)
  const stats = { quiet: +quiet.toFixed(5), median: +median.toFixed(5), loud: +loud.toFixed(5),
    peak: +peak.toFixed(4), dynamicRange: dyn === Infinity ? null : +dyn.toFixed(1) }
  if (peak < 0.002)
    return { ok: false, stats, reason: 'the input is digitally silent — macOS is almost certainly denying microphone permission to this terminal (System Settings > Privacy & Security > Microphone)' }
  if (median > 0.15 && dyn < 3)
    return { ok: false, stats, reason: `loud and unvarying (median ${stats.median}, dynamic range ${stats.dynamicRange}x) — something continuous is playing near the microphone, and speech recorded over it transcribes as nothing` }
  return { ok: true, stats }
}

function ffmpegSegment(dir, spec, n) {
  const wav = path.join(dir, `audio.${n}.wav`)
  // -progress pairs a position in the audio with a position on the system
  // clock, repeatedly. That is what makes the audio clock measurable instead of
  // assumed, and unlike an acoustic beacon it needs no speakers -- which
  // matters when the microphone is nowhere near the machine.
  const args = ['-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-i', spec,
    // Hold the file to real time. avfoundation delivers fewer samples than wall
    // time says have elapsed -- measured at 10.8% to 18.5% on this machine, and
    // NOT caused by the pre-flight audition or by the 48k->16k conversion, both
    // of which were tested and cleared (probes/capture-drop.mjs). Without this
    // filter ffmpeg writes only what it receives, so the file falls behind and
    // every position in it maps to a wall time that is too early by a margin
    // that grows all session. That does not look like a bug when you read the
    // transcript: it looks like a person anticipating the prompt. async=1 fills
    // the gap instead, which keeps audio position and elapsed time the same
    // quantity. Measured after: 0.0%.
    '-af', 'aresample=async=1:min_hard_comp=0.100',
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

  start({ audition = true } = {}) {
    const mic = defaultMicSpec()
    if (!mic.ok) throw new Error(`no usable default microphone: ${mic.reason}`)
    if (audition) {
      const a = auditionMic(mic.spec)
      this.audition = a
      if (!a.ok) {
        const e = new Error(`microphone will not record usable speech: ${a.reason}`)
        e.stats = a.stats
        throw e
      }
      this.onEvent({ kind: 'mic-audition', device: mic.name, ...a.stats })
    }
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

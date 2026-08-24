// Microphone capture through the signed rewalk-mic.app bundle.
//
// A drop-in for lib/mic.mjs's Mic, used only by the extension's native host,
// which macOS will not grant the mic any other way (a bare node process has no
// Info.plist to attribute a grant to; the bundle does). Its shape matches Mic
// on purpose -- .segments[i].ticks, .stop(), .manifest() -- so the host's
// finalize and fitProgressClock consume it without knowing which capturer ran.
//
// The bundle writes the wav itself and emits (audioMs, wall) ticks on stderr,
// the same clock signal ffmpeg -progress gave the CLI, so a session recorded
// this way carries an identical audioClocks entry.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readPcm } from '../align.mjs'
import { classifyAudition } from '../mic.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_BIN = path.join(HERE, 'rewalk-mic.app', 'Contents', 'MacOS', 'rewalk-mic')

export function bundleAvailable() { return fs.existsSync(APP_BIN) }

/** Record a short clip through the bundle and judge it, same gate as ffmpeg. */
export async function auditionBundle(seconds = 3) {
  if (!bundleAvailable()) return { ok: false, reason: `rewalk-mic.app is not built (${APP_BIN})` }
  const tmp = path.join(os.tmpdir(), `rewalk-bundle-audition-${process.pid}.wav`)
  await new Promise((resolve) => {
    const p = spawn(APP_BIN, [tmp], { stdio: ['ignore', 'ignore', 'ignore'] })
    setTimeout(() => { try { p.kill('SIGINT') } catch (e) {} }, seconds * 1000)
    p.on('close', resolve)
    setTimeout(resolve, seconds * 1000 + 3000)   // never hang the session on a stuck helper
  })
  let pcm
  try { pcm = readPcm(tmp) } catch (e) { return { ok: false, reason: `unreadable capture: ${e.message}` } }
  finally { try { fs.unlinkSync(tmp) } catch (e) {} }
  return classifyAudition(pcm.samples, pcm.sampleRate)
}

export class BundleMic {
  constructor(dir, { onEvent = () => {} } = {}) {
    this.dir = dir
    this.onEvent = onEvent
    this.segments = []
    this.closed = false
  }

  start({ audition = true } = {}) {
    if (!bundleAvailable()) throw new Error(`rewalk-mic.app is not built (${APP_BIN})`)
    // Audition is async; the host awaits startAsync when it wants the gate.
    if (audition) throw new Error('use startAsync() for the audited bundle path')
    this._open()
    return this
  }

  async startAsync({ audition = true } = {}) {
    if (!bundleAvailable()) throw new Error(`rewalk-mic.app is not built (${APP_BIN})`)
    if (audition) {
      const a = await auditionBundle()
      this.audition = a
      if (!a.ok) { const e = new Error(`microphone will not record usable speech: ${a.reason}`); e.stats = a.stats; throw e }
      this.onEvent({ kind: 'mic-audition', device: 'rewalk-mic.app', ...a.stats })
    }
    this._open()
    return this
  }

  _open() {
    const wav = path.join(this.dir, `audio.${this.segments.length + 1}.wav`)
    const proc = spawn(APP_BIN, [wav], { stdio: ['ignore', 'ignore', 'pipe'] })
    const seg = { file: wav, startedWall: Date.now(), ticks: [], stderr: '',
      device: { name: 'rewalk-mic.app', spec: 'bundle', uid: 'com.rewalk.mic' }, proc }
    let buf = ''
    proc.stderr.on('data', (d) => {
      buf += d
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const l of lines) {
        if (!l.trim()) continue
        let j; try { j = JSON.parse(l) } catch (e) { seg.stderr += l; continue }
        if (j.type === 'tick' && Number.isFinite(j.audioMs) && Number.isFinite(j.wall)) seg.ticks.push({ audioMs: j.audioMs, wall: j.wall })
        else if (j.type === 'error') seg.stderr += (j.message ?? '') + '\n'
      }
    })
    this.segments.push(seg)
    this.onEvent({ kind: 'mic-started', device: 'rewalk-mic.app', file: wav, at: seg.startedWall })
  }

  async _close() {
    const seg = this.segments[this.segments.length - 1]
    if (!seg || seg.endedWall) return
    seg.endedWall = Date.now()
    await new Promise((r) => { seg.proc.once('close', r); try { seg.proc.kill('SIGINT') } catch (e) {} setTimeout(r, 3000) })
  }

  async stop() {
    this.closed = true
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

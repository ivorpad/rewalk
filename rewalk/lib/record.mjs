// rewalk watch — record a human using a page.
//
// The one property that matters here is that nothing is written at the end.
// The prototype this replaces buffered the whole rrweb stream in memory and
// wrote it after the loop; the loop exited, ctx.tracing.stop() hung against a
// browser that was already gone, and the entire stream was lost. What survived
// was the step log, because that was written after every interaction. So:
// every event appends to NDJSON the moment it arrives, and a kill -9 at any
// point costs you at most the last 250ms.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { rrwebUmd } from './engine.mjs'
export const RRWEB_UMD = rrwebUmd

export function bootScript({ mask = true } = {}) {
  const rrweb = fs.readFileSync(RRWEB_UMD, 'utf8')
  const tick = fs.readFileSync(new URL('./tick.js', import.meta.url), 'utf8')
  const motion = fs.readFileSync(new URL('./motion.js', import.meta.url), 'utf8')
  const rec = `
(() => {
  if (window.__rr || location.href === 'about:blank') return;
  window.__rr = 1;
  const buf = [];
  window.__rrFlush = () => { if (buf.length) window.__rewalkEmit(buf.splice(0, buf.length)); };
  const go = () => {
    rrweb.record({
      emit: e => buf.push(e),
      inlineStylesheet: true,
      collectFonts: false,
      maskAllInputs: ${JSON.stringify(mask)},
      sampling: { mousemove: 20, scroll: 120, input: 'last' },
    });
    setInterval(window.__rrFlush, 250);
    addEventListener('pagehide', window.__rrFlush, true);
  };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', go) : go();
})();`
  return `${rrweb}\n;${rec}\n;${tick}\n;${motion}`
}

/** Append-only sink. Every call is a write; there is no flush-at-exit. */
export class Sink {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true })
    this.dir = dir
    this.fd = fs.openSync(path.join(dir, 'events.ndjson'), 'a')
    this.n = 0
  }
  push(events) {
    if (!events.length) return
    fs.writeSync(this.fd, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    this.n += events.length
  }
  meta(obj) {
    fs.writeFileSync(path.join(this.dir, 'session.json'), JSON.stringify(obj, null, 1))
  }
  close() { try { fs.closeSync(this.fd) } catch (e) {} }
}

/**
 * Mic capture. avfoundation straight to 16k mono wav, which is what whisper
 * wants and avoids a transcode step later. ffmpeg writes the wav header length
 * on exit, so we also keep the raw stream: a killed ffmpeg leaves a wav whose
 * header claims zero samples, and the raw file is still perfectly readable.
 */
export function startMic(dir, device = process.env.REWALK_MIC ?? ':1') {
  const wav = path.join(dir, 'audio.wav')
  const raw = path.join(dir, 'audio.s16le')
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', device,
    '-ac', '1', '-ar', '16000',
    '-map', '0:a', '-f', 'wav', wav,
    '-map', '0:a', '-f', 's16le', raw]
  const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const started = Date.now()
  let err = ''
  p.stderr.on('data', (d) => { err += d })
  return { proc: p, wav, raw, started, stderr: () => err,
    stop: () => new Promise((r) => { p.once('close', () => r()); p.kill('SIGINT'); setTimeout(r, 3000) }) }
}

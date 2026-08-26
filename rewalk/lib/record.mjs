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

export function bootScript({ mask = true, beacon: useBeacon = false, hud = false, transport = 'binding' } = {}) {
  const rrweb = fs.readFileSync(RRWEB_UMD, 'utf8')
  const tick = fs.readFileSync(new URL('./tick.js', import.meta.url), 'utf8')
  const motion = fs.readFileSync(new URL('./motion.js', import.meta.url), 'utf8')
  const net = fs.readFileSync(new URL('./net.js', import.meta.url), 'utf8')
  const beacon = fs.readFileSync(new URL('./beacon.js', import.meta.url), 'utf8')
  const hudJs = fs.readFileSync(new URL('./hud.js', import.meta.url), 'utf8')
  const hlJs = fs.readFileSync(new URL('./highlight.js', import.meta.url), 'utf8')
  // Two transports, one instrument bundle. The CLI reaches the host through a
  // Playwright exposeBinding (window.__rewalkEmit); the extension runs in the
  // page's MAIN world where chrome.runtime is unreachable, so it hands each
  // batch to an ISOLATED relay through a DOM CustomEvent instead. The DOM is
  // the only channel the two worlds share. Detail is JSON, not the live array:
  // structured-clone of cross-world objects is fragile, a string is not.
  // Everything below the transport line -- rrweb, tick, motion, hud -- is
  // byte-identical between the two, which is the point.
  const transportShim = transport === 'event' ? `
(() => {
  window.__rewalkEmit = (batch) => document.dispatchEvent(
    new CustomEvent('__rewalk_batch', { detail: JSON.stringify(batch) }));
  // Reverse path for the HUD: the host's RMS comes back the same way.
  document.addEventListener('__rewalk_hud', (e) => {
    try { window.__rewalkHudLevel && window.__rewalkHudLevel(Number(e.detail)); } catch (x) {}
  });
})();` : ''
  const rec = `
(() => {
  if (window.__rr || location.href === 'about:blank') return;
  window.__rr = 1;
  const buf = [];
  window.__rrFlush = () => { if (buf.length) window.__rewalkEmit(buf.splice(0, buf.length)); };
  const go = () => {
    const stopRec = rrweb.record({
      emit: e => buf.push(e),
      inlineStylesheet: true,
      collectFonts: false,
      maskAllInputs: ${JSON.stringify(mask)},
      sampling: { mousemove: 20, scroll: 120, input: 'last' },
    });
    const flushTimer = setInterval(window.__rrFlush, 250);
    addEventListener('pagehide', window.__rrFlush, true);
    // The extension's stop click broadcasts this through the relay. Stop
    // recording and go quiet; the visible instruments (hud, highlight) listen
    // for the same event and remove themselves. The CLI path never fires it —
    // there the page dies with the browser.
    document.addEventListener('__rewalk_stop', () => {
      try { stopRec && stopRec(); } catch (e) {}
      clearInterval(flushTimer);
    }, { once: true });
  };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', go) : go();
})();`
  // The acoustic beacon is off by default. It only pays for itself when the
  // microphone can hear the speakers, and it is an audible tone every few
  // seconds while someone is trying to talk. The CLI route aligns from ffmpeg's
  // progress reports instead (fitProgressClock), which needs no sound at all.
  // The HUD ships only when a human is being recorded: scripted runs have
  // nobody to inform and no reason to carry an overlay into their pixels.
  return transportShim + `\n;${rrweb}\n;${rec}\n;${tick}\n;${motion}\n;${net}` + (useBeacon ? `\n;${beacon}` : '') + (hud ? `\n;${hudJs}\n;${hlJs}` : '')
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
 * Fit wall = a*audioMs + b over the progress ticks.
 *
 * The ticks are late by however long it takes ffmpeg to encode and flush a
 * report, so `b` carries a small constant bias. That bias is bounded by the
 * reporting path (single-digit to tens of ms) rather than by device start
 * latency (hundreds), and it does not affect the slope at all -- so drift comes
 * out clean either way. The residual says whether to believe any of it.
 */
export function fitProgressClock(ticks, { trimFirst = 2 } = {}) {
  // The first reports land while the device is still spinning up and sit off
  // the line; keeping them drags the intercept.
  const t = ticks.slice(trimFirst).filter((x) => x.audioMs > 0)
  if (t.length < 3) return { ok: false, reason: `need 3 usable ticks, have ${t.length}` }
  const n = t.length
  const mx = t.reduce((s, x) => s + x.audioMs, 0) / n
  const my = t.reduce((s, x) => s + x.wall, 0) / n
  let num = 0, den = 0
  for (const x of t) { num += (x.audioMs - mx) * (x.wall - my); den += (x.audioMs - mx) ** 2 }
  const a = den === 0 ? 1 : num / den
  const b = my - a * mx
  const resid = Math.sqrt(t.reduce((s, x) => s + (x.wall - (a * x.audioMs + b)) ** 2, 0) / n)
  return {
    ok: true, ticks: n,
    startWall: +b.toFixed(2),
    driftPpm: +((a - 1) * 1e6).toFixed(1),
    residualMs: +resid.toFixed(2),
    toWall: (audioMs) => a * audioMs + b,
  }
}

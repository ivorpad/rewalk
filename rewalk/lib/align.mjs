// @ts-nocheck — pulled in by utterances.mjs; not in the typed contract set.
// Find the beacons in the waveform, and fit the audio clock to the wall clock.
//
// Two lists of times for the same physical events: the wall times the page
// stamped when it scheduled each tone, and the offsets into the audio file where
// the detector hears them. Fitting a line through the pairs recovers both the
// start offset (the capture latency nobody can predict) and the slope (the drift
// between the sound card's clock and the system clock).

import fs from 'node:fs'

/** 16-bit mono PCM out of a .wav, or a headerless .s16le. */
export function readPcm(path, { rate = 16000 } = {}) {
  const buf = fs.readFileSync(path)
  let off = 0, sampleRate = rate
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    off = 12
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'fmt ') sampleRate = buf.readUInt32LE(off + 12)
      if (id === 'data') { off += 8; break }
      off += 8 + size + (size & 1)
    }
  }
  const n = Math.floor((buf.length - off) / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + i * 2) / 32768
  return { samples: out, sampleRate }
}

/**
 * Goertzel: power at one frequency over one block. Cheaper than an FFT and we
 * only ever care about the single frequency the beacon uses.
 */
function goertzel(x, from, len, freq, rate) {
  const k = (2 * Math.PI * freq) / rate
  const coeff = 2 * Math.cos(k)
  let s0 = 0, s1 = 0, s2 = 0
  for (let i = 0; i < len; i++) {
    s0 = x[from + i] + coeff * s1 - s2
    s2 = s1; s1 = s0
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / len
}

/** Broadband energy, so a loud room does not read as a tone. */
function rms(x, from, len) {
  let s = 0
  for (let i = 0; i < len; i++) s += x[from + i] * x[from + i]
  return Math.sqrt(s / len)
}

/**
 * Onsets of every beacon burst, in ms from the start of the audio.
 * Detection is on the ratio of tone power to total power, not on absolute
 * loudness: a mic two feet away and a mic across the room should both work,
 * and speech is broadband so it lifts the denominator too.
 */
export function findBeacons(samples, sampleRate, { freq = 1970, minMs = 60, ratio = 6 } = {}) {
  const win = Math.round(sampleRate * 0.025)
  const hop = Math.round(sampleRate * 0.0025)   // finer than the 5ms first cut: hop size floors onset resolution
  const hits = []
  for (let i = 0; i + win < samples.length; i += hop) {
    const tone = Math.sqrt(Math.max(0, goertzel(samples, i, win, freq, sampleRate)))
    const all = rms(samples, i, win)
    hits.push({ at: i, strong: all > 1e-4 && tone / all > ratio })
  }
  const out = []
  let run = null
  for (const h of hits) {
    if (h.strong) { run = run ?? { start: h.at, end: h.at }; run.end = h.at }
    else if (run) {
      const ms = ((run.end - run.start) / sampleRate) * 1000
      // Derive the onset from the burst's CENTRE, not its leading edge. Under
      // noise the edge wanders by whole hops as windows cross the threshold,
      // while the centre averages that jitter out. Half the window is added
      // back because a window is stamped at its start but hears its middle.
      if (ms >= minMs) {
        const centreMs = (((run.start + run.end) / 2 / sampleRate) * 1000) + (win / sampleRate) * 500
        out.push(+(centreMs - ms / 2).toFixed(2))
      }
      run = null
    }
  }
  return out
}

/**
 * Pair detected onsets with stamped wall times and fit wall = a*audio + b.
 * Robust to missed and spurious detections; see the consensus step below.
 */
export function fitAudioClock(onsetsMs, beacons, { tolMs = 60 } = {}) {
  const walls = beacons.filter((b) => typeof b.wall === 'number').map((b) => b.wall).sort((a, b) => a - b)
  if (onsetsMs.length < 2 || walls.length < 2)
    return { ok: false, reason: `need 2 detections and 2 stamps, have ${onsetsMs.length}/${walls.length}` }

  // Pairing by order is wrong the moment one beacon is missed: everything after
  // it shifts by a whole interval and the fit inverts. A missed beacon in a
  // noisy room is the expected case, not the exotic one, so pair by consensus.
  // Each (detection, stamp) pair proposes an offset; the offset that explains
  // the most other detections is the right one.
  let best = { inliers: [] }
  for (const o of onsetsMs) {
    for (const w of walls) {
      const b = w - o
      const inliers = []
      for (const oo of onsetsMs) {
        let bestW = null, bestD = Infinity
        for (const ww of walls) {
          const d = Math.abs(ww - (oo + b))
          if (d < bestD) { bestD = d; bestW = ww }
        }
        if (bestD <= tolMs) inliers.push([oo, bestW])
      }
      // distinct stamps only: two detections must not claim the same beacon
      const seen = new Set(), uniq = []
      for (const [oo, ww] of inliers) if (!seen.has(ww)) { seen.add(ww); uniq.push([oo, ww]) }
      if (uniq.length > best.inliers.length) best = { inliers: uniq }
    }
  }
  const pairs = best.inliers
  if (pairs.length < 2) return { ok: false, reason: `no consistent pairing (best ${pairs.length})`, pairs: pairs.length }

  const n = pairs.length
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n
  const my = pairs.reduce((s, p) => s + p[1], 0) / n
  let num = 0, den = 0
  for (const [x, y] of pairs) { num += (x - mx) * (y - my); den += (x - mx) ** 2 }
  const a = den === 0 ? 1 : num / den
  const b = my - a * mx
  const resid = Math.sqrt(pairs.reduce((s, [x, y]) => s + (y - (a * x + b)) ** 2, 0) / n)
  return {
    ok: true,
    pairs: n, detections: onsetsMs.length, stamps: walls.length,
    startWall: +b.toFixed(2),           // wall time of audio sample 0
    driftPpm: +((a - 1) * 1e6).toFixed(1),
    residualMs: +resid.toFixed(2),
    toWall: (audioMs) => a * audioMs + b,
  }
}

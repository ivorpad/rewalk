// Speech in, utterances out: text with a start time you can trust.
//
// Boundaries come from energy in the waveform, and each region is transcribed
// on its own. The alternative -- transcribe the whole file with word timestamps
// and slice on those -- does not work: with `-ml 1` whisper stretches each word
// to fill its decode span, so the gap between consecutive words is 0ms at the
// 90th percentile and there are no pauses left to cut on. Measured on a real
// session, that collapsed 89 words into 2 utterances, merged two complaints
// into one line, and cut a third mid-word.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readPcm } from './align.mjs'

export const DEFAULT_MODEL = process.env.REWALK_WHISPER_MODEL ??
  '/Users/ivor/Library/Application Support/Screen Studio/models/ggml-small.bin'

/** Spans of the waveform that contain speech, in ms from the start of the file. */
export function speechRegions(samples, rate, { padMs = 150, joinMs = 450, minMs = 350 } = {}) {
  const win = Math.round(rate * 0.025)
  const frames = []
  for (let i = 0; i + win < samples.length; i += win) {
    let s = 0
    for (let j = 0; j < win; j++) s += samples[i + j] ** 2
    frames.push(Math.sqrt(s / win))
  }
  const sorted = [...frames].sort((x, y) => x - y)
  const floor_ = sorted[Math.floor(sorted.length * 0.1)]
  const loud = sorted[Math.floor(sorted.length * 0.95)]
  // Relative to the room, so a quiet talker and a hot input both work.
  //
  // The multiplicative term alone can exceed the loudest frame in the file:
  // on a recording with a high noise floor and little dynamic range, 2.5x the
  // 10th percentile came to 0.553 against a maximum of 0.527, so nothing at all
  // cleared it and the file silently produced zero utterances. Cap it below the
  // loud percentile so the threshold is always inside the signal, and let the
  // caller find out that the recording has no speech in it from the dynamic
  // range, which says so plainly, rather than from an empty result.
  const thresh = Math.min(
    Math.max(floor_ * 2.5, floor_ + (loud - floor_) * 0.1),
    floor_ + (loud - floor_) * 0.6,
  )
  const ms = (win / rate) * 1000
  const raw = []
  let run = null
  frames.forEach((v, i) => {
    if (v >= thresh) { run = run ?? { from: i * ms, to: 0 }; run.to = (i + 1) * ms }
    else if (run && i * ms - run.to > joinMs) { raw.push(run); run = null }
  })
  if (run) raw.push(run)
  // Pad outwards: a word's opening consonant is quieter than its vowel and any
  // threshold that does not clip it would also be admitting the room.
  return raw.filter((r) => r.to - r.from >= minMs)
    .map((r) => ({ from: Math.max(0, r.from - padMs), to: r.to + padMs }))
}

function writeWav(file, samples, rate) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++)
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([h, data]))
}

/**
 * Transcribe a session's audio into utterances.
 * Clips and their transcripts are cached on disk, so re-running the join over
 * the same recording costs nothing.
 */
export function transcribe(dir, wavName, { model = DEFAULT_MODEL, cacheDir = 'regions' } = {}) {
  const pcm = readPcm(path.join(dir, wavName))
  const regions = speechRegions(pcm.samples, pcm.sampleRate)
  const tmp = path.join(dir, cacheDir)
  fs.mkdirSync(tmp, { recursive: true })
  const out = []
  for (const [i, r] of regions.entries()) {
    const a = Math.round((r.from / 1000) * pcm.sampleRate)
    const b = Math.min(pcm.samples.length, Math.round((r.to / 1000) * pcm.sampleRate))
    const base = path.join(tmp, 'r' + String(i).padStart(3, '0'))
    if (!fs.existsSync(base + '.wav')) writeWav(base + '.wav', pcm.samples.subarray(a, b), pcm.sampleRate)
    if (!fs.existsSync(base + '.json')) {
      const res = spawnSync('whisper-cli',
        ['-m', model, '-f', base + '.wav', '-oj', '-of', base, '-np', '-l', 'en'], { encoding: 'utf8' })
      if (res.status !== 0) continue
    }
    let text = ''
    try {
      text = JSON.parse(fs.readFileSync(base + '.json', 'utf8')).transcription
        .map((t) => String(t.text)).join(' ').replace(/\s+/g, ' ').trim()
    } catch (e) { continue }
    // whisper annotates non-speech as [MUSIC], (wind blowing) and similar
    text = text.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim()
    if (text) out.push({ text, from: r.from, to: r.to })
  }
  return { utterances: out, regions }
}

/** wall = a*audioMs + b, from the clock the recorder measured. */
export function clockOf(meta) {
  const c = (meta.audioClocks ?? []).find((x) => x.ok)
  if (!c) return null
  const a = 1 + (c.driftPpm ?? 0) / 1e6
  return { ...c, toWall: (audioMs) => a * audioMs + c.startWall }
}

// Speech in, utterances out: text with a start time you can trust.
//
// Boundaries come from energy in the waveform, and each region is transcribed
// on its own. The alternative -- transcribe the whole file with word timestamps
// and slice on those -- does not work: with `-ml 1` whisper stretches each word
// to fill its decode span, so the gap between consecutive words is 0ms at the
// 90th percentile and there are no pauses left to cut on. Measured on a real
// session, that collapsed 89 words into 2 utterances, merged two complaints
// into one line, and cut a third mid-word.

//
// Two engines, one contract. `whisper` runs locally and keeps the audio on this
// machine; `deepgram` is a network call and is more accurate on short, noisy,
// conversational clips. Both are handed the SAME regions and return only text,
// so switching engines changes one variable and the timings stay comparable.
// Whisper stays the default because it needs no key and no network.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readPcm } from './align.mjs'

export const DEFAULT_MODEL = process.env.REWALK_WHISPER_MODEL ??
  '/Users/ivor/Library/Application Support/Screen Studio/models/ggml-small.bin'
export const DEFAULT_ENGINE = process.env.REWALK_STT ?? 'whisper'
export const DEEPGRAM_MODEL = process.env.REWALK_DEEPGRAM_MODEL ?? 'nova-3'

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

/** One clip -> text, locally. Nothing leaves the machine. */
function whisperClip(base, model) {
  const res = spawnSync('whisper-cli',
    ['-m', model, '-f', base + '.wav', '-oj', '-of', base, '-np', '-l', 'en'], { encoding: 'utf8' })
  if (res.status !== 0)
    return { ok: false, reason: `whisper-cli exited ${res.status}: ${(res.stderr ?? '').trim().slice(-160)}` }
  let text
  try {
    text = JSON.parse(fs.readFileSync(base + '.json', 'utf8')).transcription
      .map((t) => String(t.text)).join(' ')
  } catch (e) { return { ok: false, reason: `unreadable whisper output: ${e.message}` } }
  return { ok: true, text }
}

/** One clip -> text, over the network. Needs DEEPGRAM_API_KEY. */
async function deepgramClip(base, model) {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) return { ok: false, reason: 'DEEPGRAM_API_KEY is not set' }
  const q = new URLSearchParams({ model, language: 'en', smart_format: 'true', punctuate: 'true' })
  let res
  try {
    res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
      body: fs.readFileSync(base + '.wav'),
    })
  } catch (e) { return { ok: false, reason: `deepgram unreachable: ${e.message}` } }
  if (!res.ok) return { ok: false, reason: `deepgram HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` }
  const body = await res.json()
  // Cache the whole response, not just the text: confidence and word times are
  // worth having later, and re-running the join must not cost another call.
  fs.writeFileSync(base + '.deepgram.json', JSON.stringify(body))
  return { ok: true, text: readDeepgram(body) }
}

function readDeepgram(body) {
  const alt = body?.results?.channels?.[0]?.alternatives?.[0]
  return String(alt?.transcript ?? '')
}

/**
 * Transcribe a session's audio into utterances.
 *
 * Clips and their transcripts are cached on disk, so re-running the join over
 * the same recording costs nothing -- and for deepgram, costs no money. The two
 * engines cache to different filenames on purpose: sharing one would serve a
 * whisper transcript to a caller that asked for deepgram, and the comparison
 * between them is the point.
 *
 * A clip that fails to transcribe is reported, not skipped in silence. The
 * previous version did `continue` on a non-zero exit, so a missing model or an
 * expired key produced "0 utterances" and no reason.
 */
export async function transcribe(dir, wavName, { model = DEFAULT_MODEL, cacheDir = 'regions',
  engine = DEFAULT_ENGINE, dgModel = DEEPGRAM_MODEL } = {}) {
  if (engine !== 'whisper' && engine !== 'deepgram')
    throw new Error(`unknown speech engine "${engine}" (whisper | deepgram)`)
  const pcm = readPcm(path.join(dir, wavName))
  const regions = speechRegions(pcm.samples, pcm.sampleRate)
  const tmp = path.join(dir, cacheDir)
  fs.mkdirSync(tmp, { recursive: true })
  const out = [], failures = []
  for (const [i, r] of regions.entries()) {
    const a = Math.round((r.from / 1000) * pcm.sampleRate)
    const b = Math.min(pcm.samples.length, Math.round((r.to / 1000) * pcm.sampleRate))
    const base = path.join(tmp, 'r' + String(i).padStart(3, '0'))
    if (!fs.existsSync(base + '.wav')) writeWav(base + '.wav', pcm.samples.subarray(a, b), pcm.sampleRate)

    const cache = engine === 'deepgram' ? base + '.deepgram.json' : base + '.json'
    let text = null
    if (fs.existsSync(cache)) {
      try {
        const j = JSON.parse(fs.readFileSync(cache, 'utf8'))
        text = engine === 'deepgram' ? readDeepgram(j)
          : j.transcription.map((t) => String(t.text)).join(' ')
      } catch (e) { text = null }
    }
    if (text === null) {
      const res = engine === 'deepgram' ? await deepgramClip(base, dgModel) : whisperClip(base, model)
      if (!res.ok) { failures.push({ region: i, reason: res.reason }); continue }
      text = res.text
    }
    // whisper annotates non-speech as [MUSIC], (wind blowing) and similar
    text = text.replace(/\s+/g, ' ').trim().replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim()
    if (text) out.push({ text, from: r.from, to: r.to })
  }
  return { utterances: out, regions, engine, failures }
}

/**
 * wall = a*audioMs + b, reconciled against what is actually in the file.
 *
 * ffmpeg's `out_time` advances with the wall clock, not with samples written.
 * When the capture device under-delivers, out_time keeps climbing while the
 * file falls behind, and the progress fit -- which is internally consistent and
 * reports a tight residual -- silently maps every position in the file to a
 * wall time that is too early, by a margin that grows all session.
 *
 * Measured on one recording: ffmpeg reported 67.8s processed into a file
 * holding 60.67s, 10.5% short, and utterances landed 2.1s, 2.9s, 3.8s and 4.2s
 * before the prompts that caused them. A constant offset would have been
 * obvious; a drift that accumulates looks like a person anticipating.
 *
 * So compare the two and, if they disagree, stretch the mapping to fit the file
 * and say so. `dropRate` being non-zero means the capture lost audio, which is
 * worth fixing at the source; the correction only makes the recording readable.
 */
export function clockOf(meta, audioDurationMs = null) {
  const c = (meta.audioClocks ?? []).find((x) => x.ok)
  if (!c) return null
  const a = 1 + (c.driftPpm ?? 0) / 1e6
  const base = { ...c, dropRate: 0, corrected: false, toWall: (ms) => a * ms + c.startWall }
  const seg = (meta.mic ?? []).find((m) => m.file === c.file)
  if (!audioDurationMs || !seg?.startedWall || !seg?.endedWall) return base
  // What the capture spanned in wall time, minus the latency before sample 0.
  const spanMs = seg.endedWall - c.startWall
  if (spanMs <= 0 || audioDurationMs <= 0) return base
  const ratio = spanMs / audioDurationMs
  if (Math.abs(ratio - 1) < 0.02) return base       // within measurement noise
  return {
    ...c, corrected: true,
    dropRate: +(1 - audioDurationMs / spanMs).toFixed(4),
    fileMs: Math.round(audioDurationMs), spanMs: Math.round(spanMs),
    toWall: (ms) => c.startWall + ms * ratio,
  }
}

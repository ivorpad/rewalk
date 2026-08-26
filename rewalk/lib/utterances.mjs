// Speech in, utterances out: text with a start time you can trust.
//
// The default cuts on energy in the waveform and transcribes each region on its
// own, so the text and the start time come from the same place. That is not a
// preference, it is what whisper forces: with `-ml 1` it stretches each word to
// fill its decode span, so the gap between consecutive words is 0ms at the 90th
// percentile and there are no pauses left to cut on. Measured on a real
// session, slicing on those timings collapsed 89 words into 2 utterances,
// merged two complaints into one line, and cut a third mid-word.

//
// Two engines and two ways to cut the audio, kept deliberately separable.
//
//   engine   whisper (local, private, default) | deepgram (network)
//   segment  vad (energy in the waveform, default) | words (deepgram word times)
//
// The `vad` path hands both engines the SAME regions, so switching engine
// changes exactly one variable and the start times stay comparable. The `words`
// path exists because deepgram returns real word-level times where whisper's
// are unusable -- but that is a claim about deepgram, and bin/stt-compare.mjs
// measures it rather than trusting it. vad stays the default until the numbers
// say otherwise, and stays in the tree as the fallback either way.

/** @typedef {import('./types.js').SessionJson} SessionJson */
/** @typedef {import('./types.js').AudioClock} AudioClock */
/** @typedef {import('./types.js').UtteranceRow} UtteranceRow */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readPcm } from './align.mjs'

export const DEFAULT_MODEL = process.env.REWALK_WHISPER_MODEL ??
  '/Users/ivor/Library/Application Support/Screen Studio/models/ggml-small.bin'
export const DEFAULT_ENGINE = process.env.REWALK_STT ?? 'whisper'
/**
 * Deepgram defaults to cutting on its own word times; whisper cannot.
 *
 * Measured on out/session7, where the speaker ran two complaints together with
 * no pause the energy segmenter could see. The VAD merged them into one region,
 * so the second cue was paired with the third cue's sentence and its own text
 * was never available at all -- an empty hypothesis, 13 errors, and a MISS on a
 * join that had nothing wrong with it.
 *
 *   whisper/vad     WER 42.5%   3/4     deepgram/vad  WER 47.5%   3/4
 *   deepgram/words  WER 12.5%   4/4
 *
 * Note which variable moved. Deepgram's acoustic model is no better than
 * whisper's on identical regions -- it is slightly worse. All of the gain is
 * the segmentation, which is why this default is about the boundaries and not
 * about the vendor.
 */
/** @param {string} engine */
const segmentDefault = (engine) => process.env.REWALK_SEGMENT ?? (engine === 'deepgram' ? 'words' : 'vad')
export const DEEPGRAM_MODEL = process.env.REWALK_DEEPGRAM_MODEL ?? 'nova-3'
const KEY_FILE = process.env.REWALK_DEEPGRAM_KEY_FILE ??
  path.join(os.homedir(), '.config', 'rewalk', 'deepgram.key')

/** Spans of the waveform that contain speech, in ms from the start of the file. */
/**
 * @param {Float32Array|Float64Array|number[]} samples
 * @param {number} rate
 * @param {{ padMs?: number, joinMs?: number, minMs?: number }} [opts]
 * @returns {{from: number, to: number}[]}
 */
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
  /** @type {{from: number, to: number}[]} */
  const raw = []
  /** @type {{from: number, to: number}|null} */
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

/** @param {string} file @param {Float32Array|Float64Array|number[]} samples @param {number} rate */
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
/** @param {string} base @param {string} model */
function whisperClip(base, model) {
  const res = spawnSync('whisper-cli',
    ['-m', model, '-f', base + '.wav', '-oj', '-of', base, '-np', '-l', 'en'], { encoding: 'utf8' })
  if (res.status !== 0)
    return { ok: false, reason: `whisper-cli exited ${res.status}: ${(res.stderr ?? '').trim().slice(-160)}` }
  try {
    return { ok: true, text: JSON.parse(fs.readFileSync(base + '.json', 'utf8')).transcription
      .map((/** @type {{text?: string}} */ t) => String(t.text)).join(' ') }
  } catch (e) { return { ok: false, reason: `unreadable whisper output: ${e instanceof Error ? e.message : String(e)}` } }
}

/**
 * The Deepgram key, from a 0600 file rather than the environment.
 *
 * A key in an env var is inherited by every child process this spawns --
 * ffmpeg, chromium, whisper-cli -- and shows up in `ps e`. Reading it at the
 * moment of use keeps it in one process. The env var still wins if it is set,
 * because CI has nowhere to put a file.
 */
/** @returns {{ ok: true, key: string, from: string } | { ok: false, reason: string }} */
export function deepgramKey() {
  if (process.env.DEEPGRAM_API_KEY) return { ok: true, key: process.env.DEEPGRAM_API_KEY, from: 'DEEPGRAM_API_KEY' }
  try {
    const key = fs.readFileSync(KEY_FILE, 'utf8').trim()
    if (!key) return { ok: false, reason: `${KEY_FILE} is empty` }
    return { ok: true, key, from: KEY_FILE }
  } catch (e) {
    return { ok: false, reason: `no Deepgram key: set DEEPGRAM_API_KEY or write one to ${KEY_FILE}` }
  }
}

/** Never let the key reach a log line, an error message or a cached response. */
/** @param {unknown} s */
const scrub = (s) => String(s).replace(/[0-9a-f]{32,}/gi, '<key>')

/**
 * POST one wav to Deepgram and return the parsed response.
 * `extra` carries the query parameters that differ between the two paths.
 */
/** @param {string} wavPath @param {string} model @param {Record<string, string>} [extra] */
async function deepgramPost(wavPath, model, extra = {}) {
  const k = deepgramKey()
  if (!k.ok) return { ok: false, reason: k.reason }
  const q = new URLSearchParams({ model, language: 'en', smart_format: 'true', punctuate: 'true', ...extra })
  let res
  try {
    res = await fetch(`https://api.deepgram.com/v1/listen?${q}`, {
      method: 'POST',
      headers: { Authorization: `Token ${k.key}`, 'Content-Type': 'audio/wav' },
      body: fs.readFileSync(wavPath),
    })
  } catch (e) { return { ok: false, reason: `deepgram unreachable: ${scrub(e instanceof Error ? e.message : e)}` } }
  if (!res.ok) return { ok: false, reason: `deepgram HTTP ${res.status}: ${scrub((await res.text()).slice(0, 200))}` }
  try { return { ok: true, body: await res.json() } }
  catch (e) { return { ok: false, reason: `deepgram returned unparseable JSON: ${e instanceof Error ? e.message : String(e)}` } }
}

/** @param {any} body */
const dgAlt = (body) => body?.results?.channels?.[0]?.alternatives?.[0]
/** @param {any} body */
const dgText = (body) => String(dgAlt(body)?.transcript ?? '')

/** Word-level times, in ms, from a whole-file response. */
/** @param {any} body @returns {UtteranceRow[]} */
export function dgWords(body) {
  return (dgAlt(body)?.words ?? []).map((/** @type {any} */ w) => ({
    text: String(w.punctuated_word ?? w.word ?? ''),
    from: Math.round(Number(w.start) * 1000),
    to: Math.round(Number(w.end) * 1000),
    confidence: Number(w.confidence ?? 0),
  })).filter((/** @type {UtteranceRow} */ w) => w.text && Number.isFinite(w.from) && Number.isFinite(w.to))
}

/**
 * Cut a word list into utterances wherever the speaker paused.
 *
 * This is the operation whisper cannot support, and the reason it cannot is
 * measurable: if the 90th-percentile gap between consecutive words is 0ms there
 * is nothing here to cut on and every word joins one run. bin/stt-compare.mjs
 * prints that percentile for whichever engine produced the words, so the
 * decision to use this path is made on the number rather than on the vendor.
 */
/**
 * @param {UtteranceRow[]} words
 * @param {{ gapMs?: number, minWords?: number }} [opts]
 * @returns {UtteranceRow[]}
 */
export function utterancesFromWords(words, { gapMs = 450, minWords = 1 } = {}) {
  const out = []
  let run = null
  for (const w of words) {
    if (run && w.from - run.to > gapMs) { out.push(run); run = null }
    if (!run) run = { text: w.text, from: w.from, to: w.to, words: 1 }
    else { run.text += ' ' + w.text; run.to = w.to; run.words++ }
  }
  if (run) out.push(run)
  return out.filter((u) => u.words >= minWords).map(({ words: _n, ...u }) => u)
}

/** Distribution of the silences between consecutive words, in ms. */
/** @param {UtteranceRow[]} words */
export function wordGapStats(words) {
  const gaps = []
  for (let i = 1; i < words.length; i++) gaps.push(words[i].from - words[i - 1].to)
  if (!gaps.length) return { words: words.length, gaps: 0 }
  const s = [...gaps].sort((a, b) => a - b)
  /** @param {number} p */
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  return { words: words.length, gaps: gaps.length,
    p50: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1],
    // The count that matters: percentiles are all zero for any honest engine,
    // because words inside a phrase abut. What separates a usable word stream
    // from whisper's is how many gaps are big enough to be a sentence break.
    overThreshold: gaps.filter((g) => g > 450).length }
}

/**
 * Live endpointing splits one spoken sentence into fragments: measured on
 * ext-1787597169130, two sentences arrived as five cards, most of them
 * back-to-back (the `to` of one IS the `from` of the next — the endpointer
 * cut where it saw no silence at all). Stitch consecutive utterances whose
 * gap is under gapMs back into one card. `fragments` records how many pieces
 * a card was stitched from; the join is handed a card's `end` only when
 * fragments > 1, so unstitched utterances resolve exactly as before.
 */
/**
 * @param {UtteranceRow[]} utts
 * @param {number} [gapMs]
 * @returns {UtteranceRow[]}
 */
export function stitchUtterances(utts, gapMs = 600) {
  const out = []
  for (const u of utts) {
    const prev = out[out.length - 1]
    if (prev && u.from - prev.to < gapMs) {
      prev.text = `${prev.text} ${u.text}`.replace(/\s+/g, ' ').trim()
      prev.to = u.to
      prev.fragments = (prev.fragments ?? 1) + 1
    } else out.push({ ...u })
  }
  return out
}

/** Env-gated entry for the bins: stitched when REWALK_STITCH=1, untouched otherwise. */
/** @param {UtteranceRow[]} utts @param {number} [gapMs] @returns {UtteranceRow[]} */
export function maybeStitch(utts, gapMs = 600) {
  if (process.env.REWALK_STITCH !== '1') return utts
  const s = stitchUtterances(utts, gapMs)
  console.log(`REWALK_STITCH=1: ${utts.length} utterance(s) -> ${s.length} card(s)`)
  return s
}

/** @param {string} t */
const clean = (t) => String(t).replace(/\s+/g, ' ').trim()
  // whisper annotates non-speech as [MUSIC], (wind blowing) and similar
  .replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').trim()

/**
 * Transcribe a session's audio into utterances.
 *
 *   engine   'whisper' | 'deepgram'
 *   segment  'vad'   cut on energy, transcribe each region on its own
 *            'words' one call for the whole file, cut on the word times it
 *                    returns  (deepgram only -- whisper's are unusable)
 *
 * Everything is cached on disk, so re-running the join over the same recording
 * costs nothing and, for deepgram, costs no money. The caches are keyed by
 * engine on purpose: one shared cache would hand a whisper transcript to a
 * caller that asked for deepgram, and comparing the two is the point.
 *
 * A clip that fails is reported, never skipped in silence. The previous version
 * did `continue` on a non-zero exit, so a missing model or a rejected key
 * produced "0 utterances" and no reason at all.
 */
/**
 * @param {string} dir
 * @param {string} wavName
 * @param {{ model?: string, cacheDir?: string, engine?: string, segment?: string, dgModel?: string, gapMs?: number }} [opts]
 */
export async function transcribe(dir, wavName, { model = DEFAULT_MODEL, cacheDir = 'regions',
  engine = DEFAULT_ENGINE, segment = segmentDefault(engine), dgModel = DEEPGRAM_MODEL, gapMs = 450 } = {}) {
  if (engine !== 'whisper' && engine !== 'deepgram')
    throw new Error(`unknown speech engine "${engine}" (whisper | deepgram)`)
  if (segment !== 'vad' && segment !== 'words')
    throw new Error(`unknown segmentation "${segment}" (vad | words)`)
  if (segment === 'words' && engine !== 'deepgram')
    throw new Error(`segment:'words' needs engine:'deepgram' — whisper's word times are 0ms apart at p90`)

  const wav = path.join(dir, wavName)
  const tmp = path.join(dir, cacheDir)
  fs.mkdirSync(tmp, { recursive: true })

  if (segment === 'words') {
    // One call for the whole file. No VAD: the boundaries come from the same
    // response as the text, which is the arrangement the VAD was imitating.
    const cache = path.join(tmp, `whole.${dgModel}.json`)
    let body = null
    if (fs.existsSync(cache)) { try { body = JSON.parse(fs.readFileSync(cache, 'utf8')) } catch (e) { body = null } }
    if (!body) {
      const res = await deepgramPost(wav, dgModel, { utterances: 'true' })
      if (!res.ok) return { utterances: [], regions: [], engine, segment, words: [], failures: [{ region: null, reason: res.reason }] }
      body = res.body
      fs.writeFileSync(cache, JSON.stringify(body))
    }
    const words = dgWords(body)
    const utterances = utterancesFromWords(words, { gapMs })
      .map((u) => ({ ...u, text: clean(u.text) })).filter((u) => u.text)
    return { utterances, regions: utterances.map((u) => ({ from: u.from, to: u.to })),
      engine, segment, words, gaps: wordGapStats(words), failures: [] }
  }

  const pcm = readPcm(wav)
  const regions = speechRegions(pcm.samples, pcm.sampleRate)
  /** @type {UtteranceRow[]} */
  const out = []
  /** @type {{region: number, reason: string}[]} */
  const failures = []
  for (const [i, r] of regions.entries()) {
    const a = Math.round((r.from / 1000) * pcm.sampleRate)
    const b = Math.min(pcm.samples.length, Math.round((r.to / 1000) * pcm.sampleRate))
    const base = path.join(tmp, 'r' + String(i).padStart(3, '0'))
    if (!fs.existsSync(base + '.wav')) writeWav(base + '.wav', pcm.samples.subarray(a, b), pcm.sampleRate)

    const cache = engine === 'deepgram' ? `${base}.${dgModel}.json` : base + '.json'
    let text = null
    if (fs.existsSync(cache)) {
      try {
        const j = JSON.parse(fs.readFileSync(cache, 'utf8'))
        text = engine === 'deepgram' ? dgText(j) : j.transcription.map((/** @type {{text?: string}} */ t) => String(t.text)).join(' ')
      } catch (e) { text = null }
    }
    if (text === null) {
      if (engine === 'deepgram') {
        const res = await deepgramPost(base + '.wav', dgModel)
        if (!res.ok) { failures.push({ region: i, reason: res.reason ?? 'deepgram failed' }); continue }
        fs.writeFileSync(cache, JSON.stringify(res.body))
        text = dgText(res.body)
      } else {
        const res = whisperClip(base, model)
        if (!res.ok) { failures.push({ region: i, reason: res.reason ?? 'whisper failed' }); continue }
        text = res.text ?? ''
      }
    }
    text = clean(text)
    if (text) out.push({ text, from: r.from, to: r.to })
  }
  return { utterances: out, regions, engine, segment, failures }
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
/**
 * A session's speech, ready to index into the DOM stream: streamed
 * utterances.ndjson when the companion wrote one (Deepgram's live boundaries,
 * no second transcription pass), a batch transcription of the wav otherwise.
 * The one loader read, replay and walkthrough all share, so the three cannot
 * disagree about what was said. wallOf(u) is the utterance's wall time.
 */
/**
 * @param {string} dir
 * @returns {Promise<{ utterances: UtteranceRow[], engine: string|null, clock: AudioClock|null, streamed: boolean, failures: object[], wallOf: (u: UtteranceRow) => number|null }>}
 */
export async function loadUtterances(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'))
  const probe = clockOf(meta)
  const none = { utterances: [], engine: null, clock: null, streamed: false, failures: [], wallOf: () => null }
  if (!probe || !fs.existsSync(path.join(dir, probe.file))) return none
  const pcm = readPcm(path.join(dir, probe.file))
  const clock = clockOf(meta, (pcm.samples.length / pcm.sampleRate) * 1000)
  if (!clock?.toWall) return none
  const toWall = clock.toWall
  const streamedPath = path.join(dir, 'utterances.ndjson')
  if (fs.existsSync(streamedPath)) {
    const utterances = fs.readFileSync(streamedPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    return { utterances, engine: 'deepgram/stream', clock, streamed: true, failures: [],
      wallOf: (u) => u.wall ?? toWall(u.from) }
  }
  const t = await transcribe(dir, clock.file)
  return { utterances: t.utterances, engine: `${t.engine}/${t.segment}`, clock, streamed: false,
    failures: t.failures, wallOf: (u) => toWall(u.from) }
}

/**
 * @param {SessionJson} meta
 * @param {number|null} [audioDurationMs]
 * @returns {AudioClock|null}
 */
export function clockOf(meta, audioDurationMs = null) {
  const c = (meta.audioClocks ?? []).find((x) => x.ok)
  if (!c || typeof c.startWall !== 'number') return null
  const startWall = c.startWall
  const a = 1 + (c.driftPpm ?? 0) / 1e6
  /** @param {number} ms */
  const baseToWall = (ms) => a * ms + startWall
  const base = { ...c, dropRate: 0, corrected: false, toWall: baseToWall }
  const seg = (meta.mic ?? []).find((m) => m.file === c.file)
  if (!audioDurationMs || !seg?.startedWall || !seg?.endedWall) return base
  // What the capture spanned in wall time, minus the latency before sample 0.
  const spanMs = seg.endedWall - startWall
  if (spanMs <= 0 || audioDurationMs <= 0) return base
  const ratio = spanMs / audioDurationMs
  if (Math.abs(ratio - 1) < 0.02) return base       // within measurement noise
  return {
    ...c, corrected: true,
    dropRate: +(1 - audioDurationMs / spanMs).toFixed(4),
    fileMs: Math.round(audioDurationMs), spanMs: Math.round(spanMs),
    /** @param {number} ms */
    toWall: (ms) => startWall + ms * ratio,
  }
}

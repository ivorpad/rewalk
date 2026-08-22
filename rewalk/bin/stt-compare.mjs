// Which transcription setup should rewalk use, on evidence rather than vendor claims.
//
// FINDINGS.md left one instruction about Deepgram: it should make the energy
// segmentation unnecessary because it returns real word-level times, but
// "verify that against the same fixture before throwing the VAD away". This is
// that verification, and it is deliberately not the scorer -- the scorer says
// whether the join found the right delta, which is dominated by rarity and can
// come out 4/4 on a transcript containing "the car" for "the card". A join
// score that good hides the difference between engines rather than showing it.
//
// So measure the transcript directly. The guided fixture stamps the exact
// sentence each person was asked to say, so word error rate is computable
// against real ground truth rather than against a second opinion.
//
//   node bin/stt-compare.mjs <sessionDir>

import fs from 'node:fs'
import path from 'node:path'
import { readStream, extractCues } from '../lib/deltas.mjs'
import { transcribe, clockOf, wordGapStats } from '../lib/utterances.mjs'
import { readPcm } from '../lib/align.mjs'

const DIR = process.argv[2] ?? 'out/session5'
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'session.json'), 'utf8'))
const probe = clockOf(meta)
if (!probe) { console.error('no usable audio clock'); process.exit(2) }
const pcm = readPcm(path.join(DIR, probe.file))
const clock = clockOf(meta, (pcm.samples.length / pcm.sampleRate) * 1000)
const cues = extractCues(readStream(fs.readFileSync(path.join(DIR, 'events.ndjson'), 'utf8')))
  .filter((c) => c.kind === 'say-start')

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)

/**
 * Word error rate of the START of what was said against the sentence asked for.
 *
 * The prompt window deliberately runs past the cue, because people talk over
 * the end of it, so the text handed here often carries the first words of the
 * NEXT sentence. Charging those as insertions measures the harness, not the
 * engine: a perfect transcript of cue 0 scored 5 errors out of 9 purely from
 * bleed, and all three engines then looked identical because the noise was
 * larger than the difference between them.
 *
 * So the hypothesis suffix is free: take the best score over every prefix of
 * what was said, which is the standard trick for scoring an utterance embedded
 * in a longer stream. Everything a real error -- a substitution, a dropped
 * word, a word invented mid-sentence -- still counts in full.
 */
function wer(truth, said) {
  const a = norm(truth), b = norm(said)
  if (!a.length) return { wer: null, errs: 0, n: 0 }
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  const errs = Math.min(...d[a.length])
  const cut = d[a.length].indexOf(errs)
  return { wer: errs / a.length, errs, n: a.length, said: b.slice(0, cut).join(' ') }
}

const MODES = [
  { name: 'whisper/vad', engine: 'whisper', segment: 'vad' },
  { name: 'deepgram/vad', engine: 'deepgram', segment: 'vad' },
  { name: 'deepgram/words', engine: 'deepgram', segment: 'words' },
]

console.log(`${DIR}: ${(pcm.samples.length / pcm.sampleRate).toFixed(1)}s of audio, ${cues.length} cues with known text`)
if (clock.corrected) console.log(`audio clock stretched: the capture dropped ${(clock.dropRate * 100).toFixed(1)}% of its samples\n`)

const results = []
for (const m of MODES) {
  let r
  try { r = await transcribe(DIR, clock.file, { engine: m.engine, segment: m.segment }) }
  catch (e) { console.log(`${m.name.padEnd(16)} unavailable: ${e.message}`); continue }
  if (r.failures.length) { console.log(`${m.name.padEnd(16)} ${r.failures.length} failure(s): ${r.failures[0].reason}`); continue }

  // Pair each cue with the speech inside its prompt window, exactly as the
  // scorer does, so the text compared is the text the join would have seen.
  let errs = 0, words = 0
  const lines = []
  for (const c of cues) {
    const end = c.at + 9000
    const mine = r.utterances.filter((u) => {
      const w = clock.toWall(u.from)
      return w >= c.at - 500 && w <= end + 3000
    })
    const said = mine.map((u) => u.text).join(' ')
    const e = wer(c.text, said)
    errs += e.errs; words += e.n
    lines.push({ cue: c.cueIndex, asked: c.text, said: e.said, wer: e.wer, errs: e.errs })
  }
  const rate = words ? errs / words : null
  results.push({ ...m, utterances: r.utterances.length, wer: rate, errs, words, gaps: r.gaps, lines })
  console.log(`${m.name.padEnd(16)} ${String(r.utterances.length).padStart(2)} utterances   ` +
    `WER ${(rate * 100).toFixed(1)}%  (${errs}/${words} words)`)
  if (r.gaps) console.log(`${''.padEnd(16)} word gaps: p50 ${r.gaps.p50}ms  p90 ${r.gaps.p90}ms  p99 ${r.gaps.p99}ms  max ${r.gaps.max}ms  over ${r.gaps.words} words`)
}

// The decision the VAD's future rests on -- and the percentile is the wrong
// instrument for it. Words inside a fluent phrase genuinely abut, so p50 and
// p90 are 0ms for ANY engine that reports honest times; on this recording only
// 3 of 39 gaps are boundaries, which puts every percentile below p92 at zero.
// Reading that as "no pauses to cut on" is the same mistake as reading a clean
// residual on a periodic beacon as a good fit.
//
// What actually distinguishes the engines is whether the gaps that ARE large
// land where the sentences change. Whisper failed that outright: one gap over
// threshold across 89 words, so 89 words became 2 utterances. So count the
// gaps above the split threshold and check the count against the boundaries
// the waveform independently found.
const w = results.find((r) => r.segment === 'words')
const vad = results.find((r) => r.name === 'deepgram/vad') ?? results.find((r) => r.segment === 'vad')
console.log()
if (w?.gaps) {
  const big = w.gaps.overThreshold
  const agrees = vad && Math.abs(w.utterances - vad.utterances) <= 1
  console.log(`word times: ${big} of ${w.gaps.gaps} gaps exceed the 450ms split threshold` +
    ` -> ${w.utterances} utterances, against ${vad?.utterances ?? '?'} the waveform found independently.`)
  console.log(`  (p50 and p90 are 0ms and always will be: words inside a phrase abut. The percentile`)
  console.log(`   is not the test. Whisper's failure was ONE gap over threshold across 89 words.)`)
  console.log(agrees
    ? `  The two boundary sources agree, so deepgram word times are usable and the VAD can be the fallback.`
    : `  The two disagree, so the energy segmentation stays the primary boundary source.`)
}

for (const r of results) {
  console.log(`\n${r.name}`)
  for (const l of r.lines)
    console.log(`  cue ${l.cue}  ${l.errs ? `${l.errs} err` : 'exact '}  "${l.said}"`)
}

const best = results.filter((r) => r.wer != null).sort((a, b) => a.wer - b.wer)[0]
if (best) console.log(`\nlowest word error rate: ${best.name} at ${(best.wer * 100).toFixed(1)}%`)
fs.writeFileSync(path.join(DIR, 'stt-compare.json'), JSON.stringify(results, null, 1))

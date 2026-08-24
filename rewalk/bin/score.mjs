// Did the join name the right thing?
//
// The fixture's teleprompter stamps every cue into the recording: which line
// the person was asked to say, when the prompt appeared, and which node and
// property that line is about. So a session is a scored experiment rather than
// a demo -- the speech is real, the narration lag is real, the transcription
// errors are real, and the answer is known in advance.
//
//   node bin/score.mjs <sessionDir>

import fs from 'node:fs'
import path from 'node:path'
import { readStream, buildMirror, extractDeltas, extractMarks, extractObserved, extractCues } from '../lib/deltas.mjs'
import { churnProfile, resolveUtterance, ambientSuppression } from '../lib/resolve.mjs'
import { transcribe, clockOf, maybeStitch } from '../lib/utterances.mjs'
import { readPcm } from '../lib/align.mjs'

const DIR = process.argv[2] ?? 'out/session4'
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'session.json'), 'utf8'))
const probeClock = clockOf(meta)
if (!probeClock) { console.error('no usable audio clock'); process.exit(2) }
const probe = readPcm(path.join(DIR, probeClock.file))
const clock = clockOf(meta, (probe.samples.length / probe.sampleRate) * 1000)
if (!clock) { console.error('no usable audio clock'); process.exit(2) }

const events = readStream(fs.readFileSync(path.join(DIR, 'events.ndjson'), 'utf8'))
const mirror = buildMirror(events)
const deltas = extractDeltas(events, mirror)
const { marks } = extractMarks(events)
const observed = extractObserved(events)
const churn = churnProfile(deltas, marks, observed)
const ambient = ambientSuppression(deltas)
const cues = extractCues(events)

const { utterances: raw, engine, segment, failures } = await transcribe(DIR, clock.file)
const utterances = maybeStitch(raw)
for (const f of failures) console.error(`region ${f.region ?? 'whole file'} not transcribed: ${f.reason}`)

// Pair each cue with the speech that followed its prompt. The prompt window is
// generous at the end because people run past the six seconds they were given.
const starts = cues.filter((c) => c.kind === 'say-start')
console.log(`${events.length} events, ${deltas.length} deltas, ${marks.length} interactions, ${observed.size} observable`)
console.log(`audio clock: drift ${clock.driftPpm}ppm, residual ${clock.residualMs}ms`)
console.log(`${starts.length} cues, ${utterances.length} utterances via ${engine}/${segment}\n`)

let hit1 = 0, hit3 = 0, scored = 0
const rows = []
for (const c of starts) {
  const end = cues.find((x) => x.kind === 'say-end' && x.cueIndex === c.cueIndex)?.at ?? c.at + 9000
  const mine = utterances.filter((u) => {
    const w = clock.toWall(u.from)
    return w >= c.at - 500 && w <= end + 3000
  })
  if (!mine.length) { rows.push({ c, said: null }); continue }
  const text = mine.map((u) => u.text).join(' ')
  const at = clock.toWall(mine[0].from)
  const cardEnd = mine.some((u) => (u.fragments ?? 1) > 1) ? clock.toWall(mine[mine.length - 1].to) : undefined
  const r = resolveUtterance({ text, at, end: cardEnd }, { deltas, marks, churn, ambient })
  const want = c.expect ?? {}
  const propRe = new RegExp(want.prop ?? '.^')
  const list = want.held ? (r.held.length ? r.held : r.deltas) : r.deltas
  const rank = list.findIndex((d) => d.node === want.node && propRe.test(d.prop))
  scored++
  if (rank === 0) hit1++
  if (rank >= 0 && rank < 3) hit3++
  rows.push({ c, said: text, at, r, list, rank, want, lagMs: at - c.at })
}

for (const row of rows) {
  const { c, want } = row
  console.log(`cue ${c.cueIndex}  asked: "${c.text}"`)
  console.log(`         want: ${c.expect.node} ${c.expect.prop}${c.expect.held ? ' (held)' : ''}   — ${c.why}`)
  if (!row.said) { console.log(`         MISSED: no speech found in the prompt window\n`); continue }
  console.log(`         said: "${row.said.slice(0, 96)}${row.said.length > 96 ? '…' : ''}"`)
  console.log(`         spoke ${(row.lagMs / 1000).toFixed(1)}s after the prompt, ${row.r.query} query` +
    `${row.r.widened ? ', window widened' : ''}, ${row.r.interactions.length} interaction(s)`)
  const verdict = row.rank === 0 ? 'HIT (rank 1)' : row.rank > 0 ? `rank ${row.rank + 1}` : 'MISS'
  console.log(`         ${verdict}`)
  for (const d of row.list.slice(0, 3)) {
    const mark = d.node === want.node && new RegExp(want.prop ?? '.^').test(d.prop) ? '->' : '  '
    const v = d.from != null && d.to != null ? `  ${d.from} -> ${d.to}` : ''
    const ch = d.changedInSteps !== undefined ? `  (changed in ${d.changedInSteps}/${d.ofSteps} steps)` : ''
    console.log(`      ${mark} ${String(d.score).padStart(6)}  ${d.node} ${d.prop}${v}${ch}`)
  }
  console.log()
}

console.log(`top-1  ${hit1}/${scored}`)
console.log(`top-3  ${hit3}/${scored}`)
if (scored < starts.length) console.log(`${starts.length - scored} cue(s) had no speech at all`)
fs.writeFileSync(path.join(DIR, `score.${engine}-${segment}.json`), JSON.stringify(
  rows.map((r) => ({ cue: r.c.cueIndex, asked: r.c.text, said: r.said, want: r.want, rank: r.rank ?? null,
    lagMs: r.lagMs ?? null, top: r.list?.[0] ?? null })), null, 1))

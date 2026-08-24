// Probe: characterize per-signature churn to design ambient suppression (A4a).
// Throwaway. For each node+prop signature: how often it changes, whether its
// values cycle, how periodic the changes are, and whether they cluster around
// interaction marks. Run: node probes/ambient-stats.mjs out/<session>
import fs from 'node:fs'
import path from 'node:path'
import { readStream, buildMirror, extractDeltas, extractMarks } from '../lib/deltas.mjs'

const DIR = process.argv[2]
const events = readStream(fs.readFileSync(path.join(DIR, 'events.ndjson'), 'utf8'))
const mirror = buildMirror(events)
const deltas = extractDeltas(events, mirror)
const { marks } = extractMarks(events)

const bySig = new Map()
for (const d of deltas) {
  const k = `${d.node} ${d.prop}`
  if (!bySig.has(k)) bySig.set(k, [])
  bySig.get(k).push(d)
}

const t0 = deltas[0]?.at ?? 0, t1 = deltas[deltas.length - 1]?.at ?? 0
const span = Math.max(1, t1 - t0)
const markTimes = marks.map((m) => m.at)

const rows = []
for (const [k, ds] of bySig) {
  if (ds.length < 3) continue
  const ts = ds.map((d) => d.at)
  const gaps = ts.slice(1).map((t, i) => t - ts[i]).filter((g) => g > 0)
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0
  const cv = gaps.length > 1 && mean > 0
    ? Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length) / mean : null
  const values = new Set(ds.map((d) => String(d.to)))
  const active = (ts[ts.length - 1] - ts[0]) / span
  const nearMark = ds.filter((d) => markTimes.some((m) => Math.abs(d.at - m) < 2500)).length / ds.length
  rows.push({ k, n: ds.length, distinct: values.size, ratio: +(values.size / ds.length).toFixed(2),
    meanGapMs: Math.round(mean), cv: cv == null ? null : +cv.toFixed(2),
    activeFrac: +active.toFixed(2), nearMarkFrac: +nearMark.toFixed(2) })
}
rows.sort((a, b) => b.n - a.n)
console.log(`${deltas.length} deltas, ${marks.length} marks, session span ${(span / 1000).toFixed(1)}s`)
console.log('n  distinct ratio meanGap cv active nearMark  signature')
for (const r of rows.slice(0, 40))
  console.log(String(r.n).padStart(3), String(r.distinct).padStart(4), String(r.ratio).padStart(6),
    String(r.meanGapMs).padStart(7), String(r.cv ?? '-').padStart(5), String(r.activeFrac).padStart(6),
    String(r.nearMarkFrac).padStart(6), ' ', r.k.slice(0, 80))

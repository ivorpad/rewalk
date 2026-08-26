// rewalk walkthrough — the "learn a feature" artifact for someone else's site.
//
// On a third-party site `locate` is moot: there is no source on disk to fix.
// What a recording is FOR there is study — what did the feature do, in what
// order, which parts of the DOM moved at each step. This reshapes a session
// into that narrative: one section per interaction (plain clicks bound the
// steps; ⌥-click points and speech are narration inside them), with the DOM
// regions that changed before the next move, grouped and counted. Where
// resolved.json answers "what did this complaint mean", walkthrough.md
// answers "what did I just watch happen".
//
//   node bin/walkthrough.mjs <sessionDir> [outFile]
import fs from 'node:fs'
import path from 'node:path'
import { readStream, buildMirror, extractDeltas, extractMarks } from '../lib/deltas.mjs'
import { loadUtterances } from '../lib/utterances.mjs'

const DIR = process.argv[2] ?? 'out/session7'
const OUT = process.argv[3] ?? path.join(DIR, 'walkthrough.md')

const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'session.json'), 'utf8'))
const events = readStream(fs.readFileSync(path.join(DIR, 'events.ndjson'), 'utf8'))
const mirror = buildMirror(events)
const deltas = extractDeltas(events, mirror)
const { marks } = extractMarks(events)
const speech = await loadUtterances(DIR)
for (const f of speech.failures) console.error(`region ${f.region ?? 'whole file'}: ${f.reason}`)

// The same t0 the replay page uses, so #t= links land on its timeline.
const firstFull = events.findIndex((e) => e.type === 2)
if (firstFull < 0) { console.error('no full snapshot in this recording'); process.exit(2) }
const firstMeta = events.findIndex((e) => e.type === 4)
const playable = events.slice(firstMeta >= 0 && firstMeta < firstFull ? firstMeta : firstFull).filter((e) => e.type !== 5)
const t0 = playable[0].timestamp
const endWall = playable[playable.length - 1].timestamp
const rel = (w) => `+${((w - t0) / 1000).toFixed(1)}s`

const clicks = marks.filter((m) => m.kind === 'click').sort((a, b) => a.at - b.at)
const points = marks.filter((m) => m.kind === 'point')
const said = speech.utterances.map((u) => ({ text: u.text, wall: speech.wallOf(u) })).filter((u) => u.text?.trim())

// Steps: [t0..first click) is the opening; each click owns until the next.
const bounds = [{ mark: null, from: t0 }, ...clicks.map((m) => ({ mark: m, from: m.at }))]
  .map((s, i, all) => ({ ...s, to: all[i + 1]?.from ?? endWall + 1 }))

const q = (s) => '`' + String(s ?? '').replace(/`/g, "'") + '`'
// Component context captured live at the mark (tick.js walks the fiber under
// the click). Innermost name first; an all-minified chain is still reported,
// because "React, but the names didn't survive" is an answer too.
const comp = (r) => {
  if (!r) return ''
  if (r.chain?.length) return ` · ⚛ ${q(r.chain.slice(0, 3).join(' ‹ '))}`
  return r.anon ? ` · ⚛ ${r.anon} unnamed component(s)` : ''
}
const short = (v) => {
  if (v == null) return '∅'
  const s = String(v).replace(/\s+/g, ' ')
  if (!s) return '""'
  return s.length > 42 ? s.slice(0, 39) + '…' : s
}
const CAP = 10

const lines = []
lines.push(`# Walkthrough — ${meta.url ?? path.basename(DIR)}`)
lines.push('')
lines.push(`${new Date(t0).toISOString().slice(0, 16).replace('T', ' ')} · ${((endWall - t0) / 1000).toFixed(0)}s · ` +
  `${clicks.length} interaction(s) · ${said.length} utterance(s)${speech.engine ? ` (${speech.engine})` : ''} · ` +
  `${deltas.length} DOM change(s) across ${new Set(deltas.map((d) => d.node)).size} region(s)`)
lines.push('')
lines.push(`Recorded live with rewalk. Each step below is one plain click; what was`)
lines.push(`said and pointed at rides inside the step, and "changed" lists the DOM`)
lines.push(`regions that moved before the next click. Times link into replay.html.`)
if (!said.length) { lines.push(''); lines.push(`(No speech in this session — the steps carry DOM changes only.)`) }

for (const [i, step] of bounds.entries()) {
  const inWin = (at) => at >= step.from && at < step.to
  const stepSaid = said.filter((u) => inWin(u.wall))
  const stepPoints = points.filter((m) => inWin(m.at))
  const stepDeltas = deltas.filter((d) => inWin(d.at))
  if (!step.mark && !stepSaid.length && !stepPoints.length && !stepDeltas.length) continue

  lines.push('')
  lines.push(step.mark
    ? `## Step ${i} — [${rel(step.from)}](replay.html#t=${Math.round(step.from - t0)}): click ${q(step.mark.s)}${step.mark.text ? ` “${step.mark.text}”` : ''}${comp(step.mark.react)}`
    : `## Opening — before the first click`)
  for (const p of stepPoints) lines.push(`- ${rel(p.at)} pointed at ${q(p.s)}${p.text ? ` “${p.text}”` : ''}${comp(p.react)}`)
  for (const u of stepSaid) lines.push(`- ${rel(u.wall)} said: “${u.text.trim()}”`)

  // Group the step's changes by region; per region, prop first→last + count.
  const byNode = new Map()
  for (const d of stepDeltas) {
    const n = byNode.get(d.node) ?? new Map()
    const p = n.get(d.prop) ?? { from: d.from, count: 0 }
    p.to = d.to; p.count++
    n.set(d.prop, p); byNode.set(d.node, n)
  }
  const regions = [...byNode.entries()].sort((a, b) =>
    [...b[1].values()].reduce((s, p) => s + p.count, 0) - [...a[1].values()].reduce((s, p) => s + p.count, 0))
  if (regions.length) lines.push(`- changed:`)
  for (const [node, props] of regions.slice(0, CAP))
    lines.push(`  - ${q(node)} ${[...props.entries()].map(([p, v]) =>
      `${p} ${short(v.from)} → ${short(v.to)}${v.count > 1 ? ` (×${v.count})` : ''}`).join(', ')}`)
  if (regions.length > CAP)
    lines.push(`  - …and ${regions.length - CAP} more region(s): ${regions.slice(CAP).map(([n]) => q(n)).join(', ')}`)
}

// An index of the feature's moving parts, most active first.
const totals = new Map()
for (const d of deltas) totals.set(d.node, (totals.get(d.node) ?? 0) + 1)
const active = [...totals.entries()].sort((a, b) => b[1] - a[1])
lines.push('')
lines.push(`## The moving parts`)
for (const [node, n] of active.slice(0, 15))
  lines.push(`- ${q(node)} — ${n} change(s): ${[...new Set(deltas.filter((d) => d.node === node).map((d) => d.prop))].slice(0, 6).join(', ')}`)
if (active.length > 15) lines.push(`- …and ${active.length - 15} more region(s)`)
lines.push('')

// The component index — what to study when the point of the walk was to
// borrow ideas. Grouped by the innermost named component the person actually
// touched; prop keys say what the component's contract looks like without
// leaking a single value. Sessions with no fiber data (non-React pages, or
// recordings from before capture existed) emit nothing here and stay
// byte-identical.
const touched = new Map()
let anonOnly = 0
for (const m of [...clicks, ...points]) {
  const r = m.react
  if (!r) continue
  if (!r.chain?.length) { anonOnly++; continue }
  const [head, ...rest] = r.chain
  const t = touched.get(head) ?? { count: 0, inside: new Set(), props: new Set() }
  t.count++
  for (const n of rest.slice(0, 2)) t.inside.add(n)
  for (const p of r.props ?? []) t.props.add(p)
  touched.set(head, t)
}
if (touched.size || anonOnly) {
  lines.push(`## Components touched`)
  for (const [name, t] of [...touched.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const inside = t.inside.size ? ` inside ${q([...t.inside].join(' ‹ '))}` : ''
    const props = t.props.size ? ` — props: ${[...t.props].slice(0, 12).join(', ')}` : ''
    lines.push(`- ${q(name)} — ${t.count} interaction(s)${inside}${props}`)
  }
  if (anonOnly) lines.push(`- ${anonOnly} interaction(s) hit React fibers whose names did not survive minification`)
  lines.push('')
}

fs.writeFileSync(OUT, lines.join('\n'))
console.log(`${OUT}  ${bounds.length - 1} step(s), ${said.length} utterance(s), ${deltas.length} change(s)`)

// The join: an utterance in, ranked deltas out.
//
// Two things make this more than "sort by magnitude".
//
// Rarity. A UI changes a lot on every interaction. The step counter changes
// every time and is never the bug; the one property that moved on exactly one
// step usually is. Scoring by how *unusual* a change is beats scoring by how
// big it is, and it needs no vocabulary.
//
// Stasis. "the card doesn't move to where we should be explaining it" is a
// complaint that nothing happened. No ranking over things that changed can ever
// answer it. It is a different query -- over what stayed constant while its
// neighbours moved -- and the bug that motivated this tool was exactly that
// shape: scrollTop identical to the pixel across five steps.

export const DEFAULT_WINDOW = { back: 3000, fwd: 500 }

const MOTION = 'move|moves|moving|moved|jump|jumps|jumping|scroll|scrolls|follow|follows|change|changes|update|updates|track|tracks'
const STASIS_RE = new RegExp(
  `\\b(doesn'?t|does\\s+not|didn'?t|won'?t|never|not|fails?\\s+to|no)\\s+(\\w+\\s+){0,2}(${MOTION})\\b` +
  `|\\bstays?\\s+(still|put|in\\s+the\\s+same|where|there)\\b` +
  `|\\b(constant|stuck|frozen|unchanged|immobile)\\b` +
  `|\\bjust\\s+stays?\\b`,
  'i',
)
export const isStasis = (t) => STASIS_RE.test(t)

// Direction and property vocabulary. Deliberately small: the ranking must work
// without it (rarity does the heavy lifting), and every word here is one more
// thing that can be wrong.
const VOCAB = [
  [/\bleft\b|\bleftwards?\b/i, /left|rect\.x/, -1],
  [/\bright\b|\brightwards?\b/i, /left|rect\.x/, +1],
  [/\bup\b|\bhigher\b|\babove\b|\bupwards?\b/i, /top|rect\.y|scrollTop/, -1],
  [/\bdown\b|\blower\b|\bbelow\b|\bdownwards?\b/i, /top|rect\.y|scrollTop/, +1],
  [/\btaller\b|\bgrows?\b|\bbigger\b|\bexpands?\b/i, /height/, +1],
  [/\bshorter\b|\bshrinks?\b|\bsmaller\b|\bcollapses?\b/i, /height/, -1],
  [/\bwider\b/i, /width/, +1],
  [/\bnarrower\b/i, /width/, -1],
  [/\bscroll/i, /scrollTop/, 0],
  [/\bmoves?\b|\bjumps?\b|\bflies\b|\btravels?\b|\bslides?\b|\bshifts?\b|\bwander/i, /left|top|rect\.x|rect\.y/, 0],
  [/\bsize\b|\bresizes?\b/i, /width|height/, 0],
  [/\bfades?\b|\bfading\b|\bdims?\b/i, /opacity/, 0],
  [/\blingers?\b|\btrails?\b|\bsmears?\b|\bslow\b|\blags?\b|\bdrags?\b/i, /transition|motion\.cancels/, 0],
  [/\bsliding\b|\bslides?\b|\bwander|\ball\s+over\b|\baround\b|\bbounces?\b|\bstutters?\b/i, /motion\.path|motion\.wander|motion\.cancels/, 0],
]

const STOP = new Set(['the', 'an', 'it', 'is', 'to', 'of', 'and', 'that', 'this', 'we',
  'should', 'would', 'when', 'then', 'there', 'here', 'on', 'in', 'at', 'be', 'get', 'go', 'goes',
  'going', 'its', "it's", 'but', 'so', 'just', 'tad', 'bit', 'little', 'not', 'now'])

const words = (t) => t.toLowerCase().match(/[a-z][a-z'-]+/g) ?? []

/** Steps are marks; without marks, fall back to fixed slices. */
function stepBounds(marks, deltas, span = 4000) {
  if (marks.length >= 2) {
    const t = marks.map((m) => m.at).sort((a, b) => a - b)
    return t.map((x, i) => [x - 200, i + 1 < t.length ? t[i + 1] - 200 : x + span])
  }
  if (!deltas.length) return []
  const lo = deltas[0].at, hi = deltas[deltas.length - 1].at
  const out = []
  for (let x = lo; x < hi; x += span) out.push([x, x + span])
  return out
}

/** How often does this node+prop change across the whole session? */
export function churnProfile(deltas, marks, observed = new Set()) {
  const steps = stepBounds(marks, deltas)
  const seen = new Map()
  for (const k of observed) seen.set(k, 0)   // observable, never moved
  for (const [lo, hi] of steps) {
    const here = new Set()
    for (const d of deltas) if (d.at >= lo && d.at < hi) here.add(`${d.node} ${d.prop}`)
    for (const k of here) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return { steps: steps.length || 1, seen }
}

const sig = (d) => `${d.node} ${d.prop}`

/**
 * Ambient churn: a CSS loop that runs all session (a badge pulsing
 * 19↔34↔38 every ~2s) is the rarest-looking thing in any single quiet window,
 * so it outranks the person's actual referent. Measured on ext-1787597169130:
 * the pulse changes 81 times in 30s — 2.7/s, values cycling through a small
 * repeated set (distinct/n 0.28), active over 99% of the session — while every
 * interaction-driven signature in the scored fixtures stays under 0.4/s.
 * Rate over the active span + value revisits + session-wide spread separate
 * them. Gap periodicity does NOT: the pulse's rect samples arrive in bursts
 * (gap CV ≈ 1.0), so a "regular interval" test misses it.
 */
export function ambientSignatures(deltas) {
  const out = new Set()
  if (!deltas.length) return out
  const bySig = new Map()
  for (const d of deltas) {
    const k = sig(d)
    let e = bySig.get(k)
    if (!e) bySig.set(k, e = { first: d.at, last: d.at, n: 0, values: new Set() })
    e.n++; e.last = d.at; e.values.add(String(d.to))
  }
  const span = Math.max(1, deltas[deltas.length - 1].at - deltas[0].at)
  for (const [k, e] of bySig) {
    if (e.n < 10) continue
    const active = e.last - e.first
    if (active / span < 0.5) continue                       // sustained, not one burst
    if (e.n / (Math.max(1000, active) / 1000) < 1) continue // ≥1 change/sec while active
    if (e.values.size / e.n > 0.5) continue                 // values revisit a small set
    out.add(k)
  }
  return out
}

/** Env-gated entry for the bins: the set to suppress, or null when off. */
export function ambientSuppression(deltas) {
  if (process.env.REWALK_SUPPRESS_AMBIENT !== '1') return null
  const s = ambientSignatures(deltas)
  console.log(`REWALK_SUPPRESS_AMBIENT=1: ${s.size} ambient signature(s)` +
    (s.size ? ` — ${[...s].map((k) => k.length > 64 ? k.slice(0, 61) + '…' : k).join('; ')}` : ''))
  return s
}

/**
 * How well does a node answer the thing that was pointed at? Exact hit first,
 * then anywhere on the ancestor chain, decaying with distance -- you point at
 * the highlighted line, and the container that never scrolled is three levels
 * up but is still what you meant.
 */
function pointScore(point, nodeText) {
  if (!point?.s) return 0
  if (nodeText === point.s.toLowerCase()) return 1
  const chain = (point.chain ?? [point.s]).map((c) => String(c).toLowerCase())
  const i = chain.indexOf(nodeText)
  if (i >= 0) return +Math.max(0.4, 1 - i * 0.15).toFixed(3)
  if (chain.some((c) => c && (nodeText.includes(c) || c.includes(nodeText)))) return 0.4
  return 0
}

/**
 * Resolve one utterance.
 * u = {text, at, end?}, where at is the wall ms of the START of the utterance.
 * `end` (wall ms) is passed only for stitched cards (A4b): a card sewn from
 * several fragments spans longer than the window was designed for, so the
 * window and the deixis search must run through the card's end or the deltas
 * that the LAST fragment was about fall outside it.
 */
export function resolveUtterance(u, { deltas, marks, churn, window = DEFAULT_WINDOW, ambient = null }) {
  const lo = u.at - window.back, hi = (u.end ?? u.at) + window.fwd
  const inWin = deltas.filter((d) => d.at >= lo && d.at <= hi)
  const w = words(u.text)
  const content = w.filter((x) => !STOP.has(x))

  // Deixis: the point-mark that travels with THIS utterance.
  //
  // Push-to-talk means you point at the thing while you are saying it, so the
  // mark sits within a couple of seconds of the words. A looser window lets one
  // alt-click attach itself to every utterance that follows it: measured, a
  // point made for one complaint was still scoring deixis 1 on a complaint four
  // seconds later and winning on it.
  // A stitched card keeps every point inside its span — each clause pointed at
  // its own referent. An unstitched utterance keeps the single-last-point rule
  // exactly as before.
  const POINT_BACK = 2000, POINT_FWD = 500
  const allPoints = marks.filter((m) => m.kind === 'point' && m.at <= (u.end ?? u.at) + POINT_FWD && m.at >= u.at - POINT_BACK)
  const points = u.end != null ? allPoints : allPoints.slice(-1)
  const deixisOf = (nodeText) => points.reduce((best, p) => Math.max(best, pointScore(p, nodeText)), 0)

  const vocab = VOCAB.filter(([re]) => re.test(u.text))
  const propRes = vocab.map(([, p]) => p)
  const propRe = propRes.length ? new RegExp(propRes.map((p) => p.source).join('|')) : null
  const dirs = vocab.filter(([, , d]) => d !== 0).map(([, p, d]) => [p, d])

  const stasis = isStasis(u.text)
  const maxMag = Math.max(1, ...inWin.map((d) => d.mag ?? 0))

  const score = (d) => {
    const parts = {}
    const n = Math.max(1, churn.seen.get(sig(d)) ?? 1)
    parts.rarity = +(Math.log(1 + churn.steps / n) / Math.log(1 + churn.steps)).toFixed(3)
    parts.magnitude = d.mag != null ? +(Math.log1p(d.mag) / Math.log1p(maxMag)).toFixed(3) : 0
    // Score how MANY of the utterance's property words this delta answers, not
    // whether any of them do. "lingers when it fades" names two things:
    // transition.opacity answers both, transition.left answers one, and a union
    // match calls that a tie.
    parts.prop = propRes.length ? +(propRes.filter((p) => p.test(d.prop)).length / propRes.length).toFixed(3) : 0
    parts.direction = 0
    for (const [p, dir] of dirs) {
      if (!p.test(d.prop)) continue
      const a = parseFloat(d.from), b = parseFloat(d.to)
      if (Number.isFinite(a) && Number.isFinite(b)) parts.direction = Math.sign(b - a) === dir ? 1 : -1
    }
    const nodeText = String(d.node).toLowerCase()
    parts.noun = content.some((c) => c.length > 2 && nodeText.includes(c)) ? 1 : 0
    parts.deixis = deixisOf(nodeText)
    const centre = u.at - window.back * 0.45
    parts.proximity = +Math.exp(-(((d.at - centre) / (window.back * 0.7)) ** 2)).toFixed(3)

    const total =
      3.0 * parts.rarity + 1.6 * parts.magnitude + 2.0 * parts.prop + 1.4 * parts.direction +
      1.8 * parts.noun + 2.5 * parts.deixis + 0.8 * parts.proximity
    return { ...d, score: +total.toFixed(3), parts }
  }

  // Collapse repeats of the same node+prop inside the window into one delta
  // spanning the whole window: a transition arrives as ten 15px rect steps and
  // is one 150px movement, not ten small ones.
  const byKey = new Map()
  for (const d of inWin) {
    const k = sig(d)
    const cur = byKey.get(k)
    if (!cur) { byKey.set(k, { ...d, ticks: 1 }); continue }
    cur.to = d.to; cur.ticks++
    const a = parseFloat(cur.from), b = parseFloat(d.to)
    if (Number.isFinite(a) && Number.isFinite(b)) cur.mag = Math.abs(b - a)
    cur.at = d.at
  }
  let merged = [...byKey.values()].filter((d) => !(d.kind === 'rect' && d.mag === 0))

  // When several nodes report the identical change at the identical moment,
  // one of them moved and the rest were carried. The largest box is the
  // container, so it is the one worth naming; the others were ties decided by
  // map order, which is not a decision.
  const cluster = new Map()
  for (const d of merged) {
    if (d.kind !== 'rect') continue
    const k = `${d.prop}|${d.from}|${d.to}`
    const cur = cluster.get(k)
    if (!cur || (d.area ?? 0) > (cur.area ?? 0)) cluster.set(k, d)
  }
  merged = merged.filter((d) => d.kind !== 'rect' || cluster.get(`${d.prop}|${d.from}|${d.to}`) === d)

  // Ambient suppression, with one escape hatch: a ⌥-point on the pulsing thing
  // means the pulse IS the referent, so deixis beats suppression. Suppressed
  // signatures are reported, not hidden — "only ambient churn happened here"
  // is an answer.
  const suppressed = []
  if (ambient?.size) {
    merged = merged.filter((d) => {
      if (!ambient.has(sig(d)) || deixisOf(String(d.node).toLowerCase()) > 0) return true
      suppressed.push({ node: d.node, prop: d.prop, ticks: d.ticks ?? 1 })
      return false
    })
  }

  const ranked = merged.map(score).sort((a, b) => b.score - a.score)
  let held = []
  if (stasis) {
    // What stayed put while the rest of the page moved. A property is a stasis
    // candidate if the session shows it changing sometimes, but not here.
    const movedHere = new Set(merged.map(sig))
    held = [...churn.seen.entries()]
      .filter(([k]) => !movedHere.has(k))
      .map(([k, n]) => {
        const ix = k.lastIndexOf(' ')
        const node = k.slice(0, ix), prop = k.slice(ix + 1)
        const nodeText = node.toLowerCase()
        const noun = content.some((c) => c.length > 2 && nodeText.includes(c)) ? 1 : 0
        const propHit = propRe && propRe.test(prop) ? 1 : 0
        const dx = deixisOf(nodeText)
        const never = n === 0 ? 1 : 0
        // "it doesn't scroll" is rarely about the document: a root scroller is
        // the least specific answer available and was winning ties on nothing.
        const root = /^(html|body|#document)$/i.test(node) ? -0.9 : 0
        const depth = Math.min(0.4, 0.1 * (node.match(/>/g)?.length ?? 0))
        return { node, prop, kind: 'held', changedInSteps: n, ofSteps: churn.steps,
          score: +(2.2 * propHit + 2.0 * noun + 2.5 * dx + 1.2 * (n / churn.steps) + 1.5 * never + root + depth).toFixed(3) }
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
  }

  return {
    said: u.text,
    at: u.at,
    window: [lo, hi],
    query: stasis ? 'stasis' : 'motion',
    pointedAt: points.length ? points.map((p) => p.s).join(' ; ') : null,
    interactions: marks.filter((m) => m.at >= lo && m.at <= hi).map((m) => ({ at: m.at, kind: m.kind, s: m.s, text: m.text })),
    deltas: ranked.slice(0, 8),
    held: held.slice(0, 5),
    ...(ambient ? { ambientSuppressed: suppressed } : {}),
  }
}

/**
 * Clock. rrweb stamps Date.now(); the transcript counts from the first audio
 * sample. Fit wall = a*elapsed + b over every clock pair rather than trusting
 * one anchor, and report the residual so a bad fit is visible instead of silent.
 */
export function fitClock(clocks) {
  if (clocks.length < 2) {
    const c = clocks[0]
    return { a: 1, b: c ? c.wall - c.recorderElapsedMs : 0, residualMs: null, n: clocks.length }
  }
  const n = clocks.length
  const sx = clocks.reduce((s, c) => s + c.recorderElapsedMs, 0)
  const sy = clocks.reduce((s, c) => s + c.wall, 0)
  const sxx = clocks.reduce((s, c) => s + c.recorderElapsedMs ** 2, 0)
  const sxy = clocks.reduce((s, c) => s + c.recorderElapsedMs * c.wall, 0)
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  const b = (sy - a * sx) / n
  const residual = Math.sqrt(clocks.reduce((s, c) => s + (c.wall - (a * c.recorderElapsedMs + b)) ** 2, 0) / n)
  return { a, b, residualMs: +residual.toFixed(2), n, driftPpm: +((a - 1) * 1e6).toFixed(1) }
}

// Turn an rrweb NDJSON stream into deltas that name elements.
//
// rrweb speaks in node ids. A delta that says "node 412 changed" is useless to
// a human and useless to an assertion, so we rebuild just enough of the mirror
// from the full snapshot to turn an id back into a selector and a tag.

/** @typedef {import('./types.js').Delta} Delta */
/** @typedef {import('./types.js').Mark} Mark */
/** @typedef {import('./types.js').ClockPair} ClockPair */
/** @typedef {import('./types.js').MirrorNode} MirrorNode */
/** @typedef {import('./types.js').RrwebEvent} RrwebEvent */

const T_FULL = 2, T_INCR = 3, T_CUSTOM = 5
const S_MUTATION = 0, S_SCROLL = 3

/** @param {string} text @returns {RrwebEvent[]} */
export function readStream(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch (e) {}
  }
  events.sort((a, b) => a.timestamp - b.timestamp)
  return events
}

/**
 * id -> {tag, attrs, parent}. Enough to name a node, not to replay one.
 * @param {RrwebEvent[]} events
 * @returns {Map<number, MirrorNode>}
 */
export function buildMirror(events) {
  const m = new Map()
  /** @param {any} n @param {number|null} parent */
  const add = (n, parent) => {
    if (!n) return
    if (n.type === 2) m.set(n.id, { tag: n.tagName, attrs: { ...n.attributes }, parent })
    else if (n.type === 3) m.set(n.id, { tag: '#text', attrs: {}, parent })
    else if (n.type === 0 || n.type === 1) m.set(n.id, { tag: '#doc', attrs: {}, parent })
    for (const c of n.childNodes ?? []) add(c, n.id)
  }
  for (const e of events) {
    if (e.type === T_FULL) add(e.data.node, null)
    else if (e.type === T_INCR && e.data.source === S_MUTATION) {
      for (const a of e.data.adds ?? []) add(a.node, a.parentId)
      for (const at of e.data.attributes ?? []) {
        const n = m.get(at.id)
        if (n) for (const [k, v] of Object.entries(at.attributes)) {
          if (v === null) delete n.attrs[k]; else n.attrs[k] = v
        }
      }
    }
  }
  return m
}

/**
 * A name a person can read and a check can re-find.
 * @param {Map<number, MirrorNode>} m
 * @param {number} id
 * @returns {string}
 */
export function nameOf(m, id) {
  const n = m.get(id)
  if (!n) return `node#${id}`
  const a = n.attrs ?? {}
  if (a.id) return `#${a.id}`
  if (a['aria-label']) return `[aria-label="${a['aria-label']}"]`
  if (a['data-testid']) return `[data-testid="${a['data-testid']}"]`
  if (n.tag === '#text') {
    if (n.parent == null) return '#text'
    const p = m.get(n.parent)
    return p ? `${nameOf(m, n.parent)}/text()` : '#text'
  }
  if (a['data-line']) return `${n.tag}[data-line="${a['data-line']}"]`
  const cls = String(a.class ?? '').split(/\s+/).filter(Boolean).slice(0, 2)
  const base = n.tag + cls.map((c) => '.' + c).join('')
  return n.parent != null && m.get(n.parent) ? `${shallow(m, n.parent)} > ${base}` : base
}
/** @param {Map<number, MirrorNode>} m @param {number} id */
const shallow = (m, id) => {
  const n = m.get(id)
  if (!n) return '?'
  const a = n.attrs ?? {}
  if (a.id) return `#${a.id}`
  if (a['aria-label']) return `[aria-label="${a['aria-label']}"]`
  return n.tag ?? '?'
}

/**
 * Is this node part of the harness rather than the app?
 *
 * The teleprompter rewrites its own text every few seconds, which would
 * otherwise be the rarest, most recent, most magnitude-laden change in every
 * window -- the instrument outscoring the thing it is measuring.
 */
/** @param {Map<number, MirrorNode>} m @param {number} id */
export function isInstrument(m, id) {
  for (let n = m.get(id), hops = 0; n && hops < 12; n = n.parent == null ? undefined : m.get(n.parent), hops++) {
    const id = n.attrs?.id
    if (id === 'rewalk-cue' || id === 'rewalk-hud' || id === 'rewalk-hud-toast' || id === 'rewalk-hud-hl' || id === 'rewalk-comment') return true
  }
  return false
}

/** @param {unknown} v */
const num = (v) => {
  const x = parseFloat(String(v ?? '').replace(/[^-\d.]/g, ''))
  return Number.isFinite(x) ? x : null
}

/**
 * Every change in the stream, flattened to one shape:
 *   {at, kind, node, prop, from, to, mag}
 * mag is the numeric magnitude when both ends parse as numbers, else null.
 * Style is split per-property, because "the style attribute changed" hides the
 * one number that was the whole story.
 */
/**
 * @param {RrwebEvent[]} events
 * @param {Map<number, MirrorNode>} m
 * @returns {Delta[]}
 */
export function extractDeltas(events, m) {
  const out = []
  const styleState = new Map()

  /** @param {number} id @param {unknown} styleVal */
  const styleProps = (id, styleVal) => {
    const cur = new Map()
    for (const decl of String(styleVal ?? '').split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      cur.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim())
    }
    return cur
  }

  for (const e of events) {
    const at = e.timestamp
    if (e.type === T_INCR && e.data.source === S_MUTATION) {
      for (const at_ of e.data.attributes ?? []) {
        if (isInstrument(m, at_.id)) continue
        const node = nameOf(m, at_.id)
        for (const [k, v] of Object.entries(at_.attributes)) {
          if (k === 'style') {
            // rrweb sends style either as a whole string or as a partial object
            const prev = styleState.get(at_.id) ?? new Map()
            const next = typeof v === 'object' && v
              ? new Map([...prev, ...Object.entries(v).map(([p, q]) => [p, Array.isArray(q) ? q[0] : q])])
              : styleProps(at_.id, v)
            for (const [p, q] of next) {
              const before = prev.get(p)
              if (before === q) continue
              const nq = num(q), nb = num(before)
              out.push({ at, kind: 'attr', node, prop: `style.${p}`, from: before ?? null, to: q,
                mag: nq != null && nb != null ? Math.abs(nq - nb) : null })
            }
            for (const [p, q] of prev) if (!next.has(p))
              out.push({ at, kind: 'attr', node, prop: `style.${p}`, from: q, to: null, mag: null })
            styleState.set(at_.id, next)
          } else {
            out.push({ at, kind: 'attr', node, prop: k, from: null, to: v == null ? null : String(v), mag: null })
          }
        }
      }
      for (const t of e.data.texts ?? []) {
        if (isInstrument(m, t.id)) continue
        out.push({ at, kind: 'text', node: nameOf(m, t.id), prop: 'text', from: null, to: String(t.value).slice(0, 80), mag: null })
      }
    } else if (e.type === T_INCR && e.data.source === S_SCROLL) {
      out.push({ at, kind: 'scroll', node: nameOf(m, e.data.id), prop: 'scrollTop', from: null, to: e.data.y, mag: null })
    } else if (e.type === T_CUSTOM) {
      const d = e.data.payload ?? {}
      if (e.data.tag === 'rewalk-rects') {
        for (const r of d.rects ?? []) {
          const [px, py, pw, ph] = r.from, [x, y, w, h] = r.to
          for (const [prop, a, b] of [['rect.x', px, x], ['rect.y', py, y], ['rect.width', pw, w], ['rect.height', ph, h]])
            if (a !== b) out.push({ at, kind: 'rect', node: r.s, prop, from: a, to: b, mag: Math.abs(b - a), area: w * h })
        }
      } else if (e.data.tag === 'rewalk-motion-window') {
        // Emitted when motion settles, so date-stamp it back to when it began.
        const began = at - (d.settleMs ?? 0)
        for (const t of d.tracks ?? []) {
          if (!t.s) continue
          if (t.path > 0) out.push({ at: began, kind: 'motion', node: t.s, prop: 'motion.path', from: 0, to: t.path, mag: t.path })
          // path/net: 400px travelled to end up 100px away is "it wanders
          // about"; 100/100 is "it moved". One ratio separates them.
          if (t.wander != null && t.wander > 1.05)
            out.push({ at: began, kind: 'motion', node: t.s, prop: 'motion.wander', from: 1, to: t.wander, mag: t.wander })
          if (d.cancels)
            out.push({ at: began, kind: 'motion', node: t.s, prop: 'motion.cancels', from: 0, to: d.cancels, mag: d.cancels })
        }
      } else if (e.data.tag === 'rewalk-motion') {
        // One delta per completed or interrupted transition. A cancel is worth
        // more than an end: it is the thing that reads as visual stutter.
        if (d.phase !== 'end' && d.phase !== 'cancel') continue
        if (!d.s) continue
        out.push({ at, kind: 'motion', node: d.s, prop: `transition.${d.prop}`,
          from: d.phase, to: `${d.elapsedTime}ms`, mag: d.elapsedTime })
      } else if (e.data.tag === 'rewalk-scroll') {
        out.push({ at, kind: 'scroll', node: d.s, prop: 'scrollTop', from: d.from, to: d.to, mag: Math.abs(d.to - d.from) })
      }
    }
  }
  return out.filter((d) => d.node && !INSTRUMENT_SEL.test(d.node)).sort((a, b) => a.at - b.at)
}

/**
 * What is *observable*, as opposed to what changed. The stasis query needs a
 * universe to range over: a scrollTop that stayed 0 all session never appears
 * in a stream of changes, and that was the whole bug.
 */
/** @param {RrwebEvent[]} events @returns {Set<string>} */
export function extractObserved(events) {
  const seen = new Set()
  for (const e of events) {
    if (e.type !== T_CUSTOM || e.data.tag !== 'rewalk-observe') continue
    const d = e.data.payload ?? {}
    for (const s of d.scrollables ?? []) if (s.s) seen.add(`${s.s} scrollTop`)
    for (const b of d.boxes ?? []) if (b.s)
      for (const p of ['rect.x', 'rect.y', 'rect.width', 'rect.height']) seen.add(`${b.s} ${p}`)
  }
  return seen
}

/** Marks (alt-click push-to-talk) and clock pairs, pulled out of the stream. */
const INSTRUMENT_SEL = /rewalk-cue|#cstep|#cdo|#csay|#chint|#cbar/

/** The request/response ledger and page errors, from the net.js instrument.
 *  Not deltas: they never enter the ranking. They ride along with each
 *  complaint's window so an agent sees what the network did when "nothing
 *  happened" on screen. */
/** @param {RrwebEvent[]} events @returns {object[]} */
export function extractNet(events) {
  const out = []
  for (const e of events) {
    if (e.type !== T_CUSTOM || e.data.tag !== 'rewalk-net') continue
    out.push({ at: e.timestamp, ...e.data.payload })
  }
  return out
}
/** @param {RrwebEvent[]} events @returns {object[]} */
export function extractConsole(events) {
  const out = []
  for (const e of events) {
    if (e.type !== T_CUSTOM || e.data.tag !== 'rewalk-console') continue
    out.push({ at: e.timestamp, ...e.data.payload })
  }
  return out
}

/** Cue marks from the teleprompter: what the person was asked to say, and when. */
/** @param {RrwebEvent[]} events @returns {object[]} */
export function extractCues(events) {
  const out = []
  for (const e of events) {
    if (e.type !== T_CUSTOM || e.data.tag !== 'rewalk-cue') continue
    out.push({ at: e.timestamp, ...e.data.payload })
  }
  return out
}

/**
 * @param {RrwebEvent[]} events
 * @returns {{ marks: Mark[], clocks: ClockPair[] }}
 */
export function extractMarks(events) {
  const marks = [], clocks = []
  for (const e of events) {
    if (e.type !== T_CUSTOM) continue
    const d = e.data.payload ?? {}
    // The payload carries its own `at` in page-elapsed ms. Spreading it after
    // `at: e.timestamp` silently replaced wall time with elapsed time, so every
    // mark sat ~50 years in the past: no interaction ever fell inside an
    // utterance's window, and the churn profile -- which buckets deltas by the
    // marks -- found nothing in any bucket and scored every candidate equally
    // rare. Keep both, and let wall time own the name the resolver uses.
    if (e.data.tag === 'rewalk-mark') marks.push({ ...d, elapsedMs: d.at, at: e.timestamp })
    else if (e.data.tag === 'rewalk-clock') clocks.push({ ...d, at: e.timestamp })
  }
  return { marks, clocks }
}

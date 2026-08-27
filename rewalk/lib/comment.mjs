// The comment envelope: what travels from a page to a coding-agent session.
//
// This is the contract everything else hangs off — the overlay builds one, the
// hub queues one, the hook renders one into an agent's context. It is versioned
// (`kind`) because the two ends upgrade at different times: the extension is
// reloaded by hand while the hub restarts on demand, and a shape change must be
// detectable rather than silently misread.
//
// Node anchors are a ladder, not a field. `s` is the same selector shape
// tick.js stamps on marks (an id if unique, else a readable path), `react` is
// the fiber chain when the page was being recorded (only the MAIN world can see
// fiber expandos), `snippet` is a trimmed outerHTML for when both of those rot.
// The receiving agent degrades down the ladder; nothing here promises more
// than the capture moment could see.
import fs from 'node:fs'
import path from 'node:path'

/**
 * @typedef {object} CommentNode
 * @property {string} s          selector, tick.js shape
 * @property {number} [at]       wall ms when the person picked it — the moment
 *                               near the change, unlike when Send was pressed
 * @property {string} [text]     visible text at capture time
 * @property {string} [snippet]  trimmed outerHTML
 * @property {{url: string}} [frame]  set when the node lives inside an iframe;
 *                               the selector resolves in THAT document
 * @property {{chain: string[], anon?: number, props?: string[]} | null} [react]
 */

/**
 * @typedef {object} Comment
 * @property {'rewalk.comment.v1'} kind
 * @property {string} [id]       hub-assigned, rwc-<n>
 * @property {string} text
 * @property {CommentNode[]} nodes
 * @property {{url?: string, title?: string}} page
 * @property {{dir: string, recording?: boolean} | null} session
 * @property {string | null} target   session_id or pid:<n>, from the picker
 * @property {{cwd?: string}} where   fallback routing when no target was picked
 * @property {number} createdWall
 * @property {string} [status]   hub-owned: held | queued | claimed | delivered
 */

export const KIND = 'rewalk.comment.v1'

const CAPS = { text: 2000, nodes: 12, selector: 300, nodeText: 120, snippet: 400, url: 500, title: 120 }

/** @param {unknown} v @param {number} cap @returns {string} */
const str = (v, cap) => String(v ?? '').slice(0, cap)

/**
 * Validate and trim a raw envelope. Returns a clean copy or the reason it is
 * not one — never throws, because both callers (hub, CLI) answer a caller of
 * their own and a stack trace answers nobody.
 * @param {unknown} raw
 * @returns {{ok: true, comment: Comment} | {ok: false, reason: string}}
 */
export function normalizeComment(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not an object' }
  const src = /** @type {Record<string, unknown>} */ (raw)
  if (src.kind !== KIND) return { ok: false, reason: `kind must be "${KIND}", got ${JSON.stringify(src.kind ?? null)}` }
  const text = str(src.text, CAPS.text).trim()
  if (!text) return { ok: false, reason: 'text is required — an empty comment carries nothing to act on' }

  /** @type {CommentNode[]} */
  const nodes = []
  if (Array.isArray(src.nodes)) {
    for (const n of src.nodes.slice(0, CAPS.nodes)) {
      if (!n || typeof n !== 'object') continue
      const o = /** @type {Record<string, unknown>} */ (n)
      const s = str(o.s, CAPS.selector).trim()
      if (!s) continue
      /** @type {CommentNode} */
      const node = { s }
      if (typeof o.at === 'number' && Number.isFinite(o.at)) node.at = o.at
      const t = str(o.text, CAPS.nodeText).trim()
      if (t) node.text = t
      const snip = str(o.snippet, CAPS.snippet).trim()
      if (snip) node.snippet = snip
      // Selected inside an iframe (a Storybook story, a docs preview). The
      // selector resolves in THAT document, not the top one, and an agent
      // querying the page URL for it would find nothing.
      if (o.frame && typeof o.frame === 'object') {
        const url = str(/** @type {Record<string, unknown>} */ (o.frame).url, CAPS.url)
        if (url) node.frame = { url }
      }
      if (o.react && typeof o.react === 'object') {
        const r = /** @type {Record<string, unknown>} */ (o.react)
        const chain = Array.isArray(r.chain) ? r.chain.map((c) => str(c, 80)).filter(Boolean).slice(0, 8) : []
        if (chain.length) {
          /** @type {{chain: string[], anon?: number, props?: string[]}} */
          const react = { chain }
          if (typeof r.anon === 'number' && r.anon > 0) react.anon = Math.floor(r.anon)
          if (Array.isArray(r.props)) {
            const props = r.props.map((p) => str(p, 60)).filter(Boolean).slice(0, 12)
            if (props.length) react.props = props
          }
          node.react = react
        }
      }
      nodes.push(node)
    }
  }

  const page = src.page && typeof src.page === 'object' ? /** @type {Record<string, unknown>} */ (src.page) : {}
  const sess = src.session && typeof src.session === 'object' ? /** @type {Record<string, unknown>} */ (src.session) : null
  const where = src.where && typeof src.where === 'object' ? /** @type {Record<string, unknown>} */ (src.where) : {}

  /** @type {Comment} */
  const comment = {
    kind: KIND,
    text,
    nodes,
    page: {
      ...(page.url ? { url: str(page.url, CAPS.url) } : {}),
      ...(page.title ? { title: str(page.title, CAPS.title) } : {}),
    },
    session: sess && typeof sess.dir === 'string' && sess.dir
      ? { dir: sess.dir, ...(sess.recording ? { recording: true } : {}) }
      : null,
    target: typeof src.target === 'string' && src.target ? str(src.target, 128) : null,
    where: { ...(where.cwd ? { cwd: str(where.cwd, 500) } : {}) },
    createdWall: typeof src.createdWall === 'number' && Number.isFinite(src.createdWall) ? src.createdWall : Date.now(),
  }
  if (typeof src.id === 'string' && src.id) comment.id = src.id
  return { ok: true, comment }
}

/**
 * The comment as the agent will read it. Compact on purpose: this lands in a
 * context window already holding the work it is about. The commands are
 * literal because "use the rewalk skill" is a suggestion and a suggestion is
 * as reliable as the agent's memory.
 * @param {Comment} c
 * @returns {string}
 */
export function renderComment(c) {
  const lines = [`<rewalk-comment id="${c.id ?? '?'}">`,
    'A person selected element(s) in their browser and left this comment for you to act on.']
  lines.push(`comment: ${c.text}`)
  const url = c.page.url ?? ''
  if (url) lines.push(`page:    ${url}${c.page.title ? `  (${c.page.title})` : ''}`)
  for (const n of c.nodes) {
    let line = `node:    ${n.s}`
    if (n.text) line += `  "${n.text}"`
    if (n.frame) line += `  [inside iframe ${n.frame.url}]`
    if (n.react?.chain.length) {
      line += `  — react: ${n.react.chain.join(' > ')}`
      if (n.react.props?.length) line += ` (props: ${n.react.props.join(', ')})`
    }
    lines.push(line)
    if (n.snippet) lines.push(`         ${n.snippet}`)
  }
  if (c.session) {
    lines.push(`session: ${c.session.dir} — a rewalk recording of the moment this was written.`)
    lines.push(`  rewalk read ${c.session.dir}      # first, if resolved.json is missing (finishing may still be running)`)
    lines.push(`  rewalk replay ${c.session.dir}    # replay.html — this comment sits on its timeline`)
    lines.push(`  rewalk locate ${c.session.dir} <the app's repo>   # map the node to the source files that render it`)
  } else if (c.nodes.length) {
    lines.push('no recording exists for this comment — work from the selector and snippet above.')
  } else {
    // Nothing was selected and nothing was recorded: all that exists is the
    // sentence and the URL. Saying "work from the selector above" when there is
    // no selector sends an agent looking for something that was never sent.
    lines.push('no elements were selected and no recording was running — this is about the page as a whole.')
  }
  lines.push('</rewalk-comment>')
  return lines.join('\n')
}

/**
 * Comments written during a recording, as the host appended them.
 *
 * Absent file = a session nobody commented on, or one recorded before comments
 * existed: an empty list, never an error, so every reader stays byte-identical
 * on the sessions that came before.
 * @param {string} dir
 * @returns {Comment[]}
 */
export function loadComments(dir) {
  let raw
  try { raw = fs.readFileSync(path.join(dir, 'comments.ndjson'), 'utf8') } catch (e) { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      const v = normalizeComment(parsed)
      if (v.ok) out.push(parsed.id ? { ...v.comment, id: parsed.id } : v.comment)
    } catch (e) {}
  }
  return out.sort((a, b) => a.createdWall - b.createdWall)
}

/**
 * @param {Comment[]} comments
 * @returns {string}
 */
export function renderAll(comments) {
  if (!comments.length) return ''
  const header = comments.length === 1 ? '' : `${comments.length} comments arrived while you were working.\n\n`
  return header + comments.map(renderComment).join('\n\n')
}

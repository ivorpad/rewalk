// Nudging an agent that is sitting at its prompt.
//
// Hooks deliver a comment the moment the agent does anything, which covers an
// agent that is working and misses entirely an agent that is idle: no tool
// calls, no Stop, no hooks, so the comment waits until a human types. That is
// exactly backwards — the idle agent is the one with nothing better to do. It
// is also what "comments never arrive" feels like from the browser, even when
// the queue is behaving perfectly.
//
// There is no portable fix. Typing into another terminal needs TIOCSTI, which
// macOS removed and Linux disabled by default in 6.2. The only things that can
// type into a pane are the programs that own the pane, so this asks them, and
// does nothing at all when none are present. rewalk works without this; it is
// just slower to notice.
//
// **It sends a nudge, never the comment.** The injected text only says one
// arrived; the content still travels the hook path, where claiming is atomic
// and leased. That makes waking idempotent — nudge twice, or nudge an agent
// that already drained the queue, and the worst case is an agent that looks and
// finds nothing. Injecting the comment itself would race the hook and deliver
// it twice.
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const NUDGE =
  'A rewalk comment arrived from someone\'s browser. Make any tool call so the ' +
  'rewalk hook can deliver it — it carries the elements they selected and, when ' +
  'a recording was running, the session directory to read back. If nothing is ' +
  'waiting, ignore this.'

/** On PATH? Scanned directly rather than shelled out to: this runs on the hub's
 * thread for every comment, and `sh -c 'command -v'` is a process each time.
 * @param {string} cmd */
function has(cmd) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true } catch (e) {}
  }
  return false
}

/** @param {string} cmd @param {string[]} args @param {number} timeout */
function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : stdout))
    } catch (e) { resolve(null) }
  })
}

/** macOS /tmp is a symlink to /private/tmp; compare real paths. */
function sameDir(a, b) {
  if (!a || !b) return false
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch (e) { return path.normalize(a) === path.normalize(b) }
}

// Memoised: the picker asks for this on every popup open and each wake asks
// again, and `herdr agent list` is a subprocess round trip.
let paneCache = { at: 0, /** @type {any[]} */ list: [] }

/** @returns {Promise<any[]>} */
export async function herdrPanes() {
  // Read per call, not at import: a test that swaps stub binaries between
  // cases needs to turn this off, and the whole point of the cache is that it
  // is invisible until it is not.
  const ttl = Number(process.env.REWALK_HERDR_TTL_MS ?? 5000)
  if (Date.now() - paneCache.at < ttl) return paneCache.list
  if (!has('herdr')) return []
  const out = await run('herdr', ['agent', 'list'], 6000)
  if (!out) return []
  try {
    paneCache = { at: Date.now(), list: JSON.parse(out).result.agents ?? [] }
    return paneCache.list
  } catch (e) { return [] }
}

/**
 * What a person calls this session, and whether it is free to take work.
 *
 * A herdr pane can be NAMED, and the name is what its owner recognises — the
 * picker showing a cwd basename means three agents in one repo are three
 * identical rows. Falls back to the terminal title, which herdr keeps in sync
 * with what the agent is doing, and then to nothing so the caller can use its
 * own slug.
 * @param {any} session
 * @returns {Promise<{name?: string, status?: string} | null>}
 */
export async function herdrLabel(session) {
  const panes = await herdrPanes()
  if (!panes.length) return null
  const pane = session.pane || ''
  const match = pane
    ? panes.find((p) => p.pane_id === pane)
    : (() => { const same = panes.filter((p) => sameDir(p.cwd ?? '', session.cwd ?? '')); return same.length === 1 ? same[0] : null })()
  if (!match) return null
  // terminal_title_stripped still carries herdr's status glyph (◑, ✳) on some
  // records, which is state, not identity — it changes while the pane does not.
  const name = String(match.name || match.terminal_title_stripped || '')
    .replace(/^[^\p{L}\p{N}#/~.]+/u, '').trim()
  return { ...(name ? { name: name.slice(0, 60) } : {}), ...(match.agent_status ? { status: String(match.agent_status) } : {}) }
}

/**
 * Ask herdr to submit a prompt to the pane this session lives in.
 *
 * Pane id first, working directory second. The id is exact, recorded from
 * HERDR_PANE_ID in the session's own environment at registration; the cwd match
 * covers sessions that registered before that existed, and is skipped when it
 * is ambiguous. Waking the wrong pane is worse than not waking — it puts a
 * stray prompt in front of somebody else's work.
 * @param {any} session
 */
async function viaHerdr(session) {
  const panes = await herdrPanes()
  if (!panes.length) return false
  const pane = session.pane || ''
  let match
  if (pane) match = panes.find((p) => p.pane_id === pane)
  else {
    const same = panes.filter((p) => sameDir(p.cwd ?? '', session.cwd ?? ''))
    match = same.length === 1 ? same[0] : undefined
  }
  if (!match) return false
  // Only an idle agent needs waking, and only an idle agent can be typed at
  // without stepping on a turn that is already running.
  if (!['idle', 'done'].includes(match.agent_status)) return false
  await run('herdr', ['agent', 'prompt', match.pane_id, NUDGE], 10_000)
  return true
}

/**
 * Type into the pane, for anyone running under plain tmux. Best effort only:
 * tmux will happily deliver keystrokes to an agent that is mid-turn, and unlike
 * herdr it cannot say whether one is. Gated on a pane id recorded at
 * registration so it can never fire at a guess.
 * @param {any} session
 */
async function viaTmux(session) {
  const pane = session.tmux_pane || ''
  if (!pane || !has('tmux')) return false
  // The socket, not just the pane. `tmux send-keys` talks to the DEFAULT
  // server, and a pane id from a `tmux -L something` server does not exist
  // there — the keystrokes go nowhere, silently. This machine's own agent
  // panes run under `-L claude-swarm-<pid>`, which is exactly that case. The
  // socket path is the first field of $TMUX inside the session, recorded at
  // registration alongside the pane id.
  const socket = session.tmux_socket ? ['-S', session.tmux_socket] : []
  const sent = await run('tmux', [...socket, 'send-keys', '-t', pane, NUDGE], 6000)
  if (sent === null) return false          // no such pane, or no such server
  await run('tmux', [...socket, 'send-keys', '-t', pane, 'Enter'], 6000)
  return true
}

/**
 * Try each route. Resolves to the one that worked, or '' for none.
 * @param {any} session
 * @returns {Promise<'herdr' | 'tmux' | ''>}
 */
export async function wake(session) {
  try {
    if (await viaHerdr(session)) return 'herdr'
    if (await viaTmux(session)) return 'tmux'
  } catch (e) {}
  return ''
}

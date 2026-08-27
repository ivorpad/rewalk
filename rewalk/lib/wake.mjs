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

// What gets injected is the COMMENT ITSELF, rendered exactly as the hook would
// render it — the selected elements, the page, the session directory to read
// back. Not a message asking the agent to go and fetch it.
//
// The reason the systems this is ported from send a nudge instead is
// double-delivery: inject the content and the hook delivers it again at the
// next tool call. The fix is ordering, not vagueness. The hub CLAIMS the
// comment for that session first — which is atomic and is the same claim the
// hook competes for — and only then injects. A failed injection puts it back
// in the queue, so the hook remains the fallback and nothing is delivered
// twice or lost.

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
  const match = await paneFor(session)
  if (!match) return null
  // terminal_title_stripped still carries herdr's status glyph (◑, ✳) on some
  // records, which is state, not identity — it changes while the pane does not.
  const name = String(match.name || match.terminal_title_stripped || '')
    .replace(/^[^\p{L}\p{N}#/~.]+/u, '').trim()
  return { ...(name ? { name: name.slice(0, 60) } : {}), ...(match.agent_status ? { status: String(match.agent_status) } : {}) }
}

/**
 * Which pane is this agent actually running in?
 *
 * Three ways, narrowing:
 *
 * 1. The pane id the session recorded from its own HERDR_PANE_ID. Exact, free,
 *    and only present for sessions that have fired a hook.
 * 2. Its PID, confirmed against what herdr says is running in each candidate
 *    pane. This is what covers a session found by the process sweep, which has
 *    no pane recorded — and it is the only thing that disambiguates three
 *    agents sitting in one repository, which is the normal case here.
 * 3. The working directory, and only when exactly one pane matches.
 *
 * Waking the wrong pane is worse than not waking: it puts a stray prompt in
 * front of somebody else's work. So an ambiguous answer is no answer.
 * @param {any} session
 */
export async function paneFor(session) {
  const panes = await herdrPanes()
  if (!panes.length) return null
  if (session.pane) return panes.find((p) => p.pane_id === session.pane) ?? null

  const inDir = panes.filter((p) => sameDir(p.cwd ?? '', session.cwd ?? '') || sameDir(p.foreground_cwd ?? '', session.cwd ?? ''))
  const candidates = inDir.length ? inDir : []
  const pid = Number(session.pid ?? 0) || Number(/^pid:(\d+)$/.exec(session.session_id ?? '')?.[1] ?? 0)
  if (pid && candidates.length) {
    for (const p of candidates) {
      const out = await run('herdr', ['pane', 'process-info', '--pane', p.pane_id], 6000)
      if (!out) continue
      try {
        const procs = JSON.parse(out).result.process_info.foreground_processes ?? []
        if (procs.some((q) => Number(q.pid) === pid)) return p
      } catch (e) {}
    }
  }
  return candidates.length === 1 ? candidates[0] : null
}

/**
 * Put text in front of the agent in this session's pane.
 *
 * Only when herdr says it is idle or done: typing at a turn that is already
 * running steps on it, and the hook will pick the comment up at that turn's
 * next tool call anyway.
 * @param {any} session @param {string} text
 */
async function viaHerdr(session, text) {
  const match = await paneFor(session)
  if (!match) return false
  if (!['idle', 'done'].includes(match.agent_status)) return false
  const out = await run('herdr', ['agent', 'prompt', match.pane_id, text], 10_000)
  return out !== null
}

/**
 * The same, for anyone running under plain tmux. Best effort only: tmux will
 * happily deliver keystrokes to an agent that is mid-turn, and unlike herdr it
 * cannot say whether one is. Gated on a pane id recorded at registration so it
 * can never fire at a guess.
 * @param {any} session @param {string} text
 */
async function viaTmux(session, text) {
  const pane = session.tmux_pane || ''
  if (!pane || !has('tmux')) return false
  // The socket, not just the pane. `tmux send-keys` talks to the DEFAULT
  // server, and a pane id from a `tmux -L something` server does not exist
  // there — the keystrokes go nowhere, silently. This machine's own agent
  // panes run under `-L claude-swarm-<pid>`, which is exactly that case. The
  // socket path is the first field of $TMUX inside the session, recorded at
  // registration alongside the pane id.
  const socket = session.tmux_socket ? ['-S', session.tmux_socket] : []
  const sent = await run('tmux', [...socket, 'send-keys', '-t', pane, text], 6000)
  if (sent === null) return false          // no such pane, or no such server
  await run('tmux', [...socket, 'send-keys', '-t', pane, 'Enter'], 6000)
  return true
}

/**
 * Put `text` in front of the agent in this session's pane. Resolves to the
 * route that worked, or '' if none could — in which case the caller must put
 * the comment back in the queue, since the hook is then the only way it will
 * ever arrive.
 * @param {any} session @param {string} text
 * @returns {Promise<'herdr' | 'tmux' | ''>}
 */
export async function deliver(session, text) {
  try {
    if (await viaHerdr(session, text)) return 'herdr'
    if (await viaTmux(session, text)) return 'tmux'
  } catch (e) {}
  return ''
}

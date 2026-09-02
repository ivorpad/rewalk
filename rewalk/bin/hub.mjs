#!/usr/bin/env node
// rewalk hub — the rendezvous between a browser and a coding-agent session.
//
// One process per user, started on demand (the SessionStart hook calls
// ensureHub, so nothing has to be remembered or added to login items). It
// listens on a unix socket in a 0700 directory and speaks one line of JSON per
// request. There is no HTTP surface and no token: the socket's directory mode
// plus Chrome's allowed_origins on the native host are the authorization.
//
// Two ways a comment reaches an agent, and only ever one of them per comment.
// The hook path is the floor: every session claims what is addressed to it when
// its own lifecycle gives it a moment. On top of that, when the target session
// is sitting idle in a pane we can reach, the hub claims the comment itself and
// puts it straight into that prompt — the content, not a note about it. The
// claim is what keeps those two from both delivering.
//
//   node bin/hub.mjs serve      run it (usually started for you)
//   node bin/hub.mjs status     what is queued, and who is live
//   node bin/hub.mjs stop       ask a running hub to exit
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { normalizeComment, renderComment } from '../lib/comment.mjs'
import { hubCall, hubStateDir, sockPath } from '../lib/hub-wire.mjs'
import { Queue, SessionRegistry, matches, sessionLabel } from '../lib/hub-state.mjs'
import { deliver, herdrLabel } from '../lib/wake.mjs'

const verb = process.argv[2] ?? 'serve'

if (verb === 'status') {
  const r = await hubCall('status', {})
  if (!r) { console.log('no hub running'); process.exit(1) }
  const sessions = /** @type {any[]} */ (r.sessions ?? [])
  const comments = /** @type {any[]} */ (r.comments ?? [])
  console.log(`hub  pid ${r.pid}  socket ${sockPath()}`)
  console.log(`\n${sessions.length} live session(s):`)
  for (const s of sessions)
    console.log(`  ${s.session_id.padEnd(38)} ${String(s.agent).padEnd(7)} ${s.label ?? s.slug}  (${s.cwd})${s.discovered ? '  [discovered]' : ''}`)
  console.log(`\n${comments.length} comment(s):`)
  for (const c of comments)
    console.log(`  ${c.id.padEnd(8)} ${String(c.status).padEnd(10)} ${JSON.stringify(String(c.text).slice(0, 60))}${c.session ? `  ${c.session.dir}` : ''}`)
  process.exit(0)
}

if (verb === 'stop') {
  const r = await hubCall('stop', {})
  console.log(r ? 'hub stopping' : 'no hub running')
  process.exit(r ? 0 : 1)
}

if (verb !== 'serve') {
  console.error(`rewalk hub: unknown verb "${verb}" — serve | status | stop`)
  process.exit(2)
}

// --- serve -------------------------------------------------------------------
const SOCK = sockPath()
const STATE = hubStateDir()
fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 })
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 })

// A socket file outlives a hub that was killed. Ping it: if something answers,
// that hub owns the address and this process has nothing to do. If nothing
// does, the file is a corpse and unlinking it is safe.
if (fs.existsSync(SOCK)) {
  if (await hubCall('ping', {}, { timeoutMs: 1000 })) process.exit(0)
  try { fs.unlinkSync(SOCK) } catch (e) {}
}

const registry = new SessionRegistry(path.join(STATE, 'live'))
const queue = new Queue(path.join(STATE, 'queue.json'), path.join(STATE, 'comments'))

// Warm the two swept caches before anybody asks.
//
// A hub is almost always started BY the thing that is about to ask it something
// — ensureHub, then immediately a request — so its first answer is also its
// coldest one, and that is the one the browser's picker waits for. Both sweeps
// memoise (processes for 10s, panes for 5s), so doing them here off the
// response path means the request that started this process finds them warm.
setTimeout(() => { labelledSessions().catch(() => {}) }, 0)

// The hub runs detached with nowhere to print, and the push path swallows its
// errors so a failure there can never wedge a comment. That combination made a
// comment that simply did not arrive impossible to explain. One line per
// decision, so the next "it never landed" is a file read rather than a guess.
const LOG = path.join(STATE, 'hub.log')
/** @param {string} m */
const log = (m) => {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`) } catch (e) {}
}

// Put the comment in front of the agent NOW, in the pane it is sitting in,
// rather than waiting for its next tool call.
//
// What goes in is the comment itself, rendered exactly as the hook renders it:
// the selected elements, the page, the session directory to read back. Not a
// message telling the agent to go and fetch it — a person who wrote a sentence
// about a button should not have it turn into "make a tool call".
//
// Exactly-once comes from ordering, not from vagueness. The comment is CLAIMED
// first — the same atomic claim the hook competes for — and only then injected,
// so the hook can never deliver it a second time. An injection that does not
// land is put back, leaving the hook as the fallback it always was.
//
// Off the response path: shelling out to herdr takes the better part of a
// second and the browser is waiting on the queue, not on this.
/** @param {any} comment */
function push(comment) {
  setTimeout(async () => {
    let claimed = null
    try {
      const live = registry.live()
      const to = live.find((s) => matches(comment, s, live.length))
      if (!to) { log(`push ${comment.id}: no live session matches target=${comment.target} cwd=${comment.where?.cwd}`); return }
      claimed = queue.claimOne(comment.id, to.session_id)
      if (!claimed) { log(`push ${comment.id}: not claimable (status ${queue.byId.get(comment.id)?.status})`); return }
      const how = await deliver(to, renderComment(claimed))
      if (!how) { queue.unclaim(comment.id); log(`push ${comment.id}: no route into ${to.slug}; left for the hook`); return }
      queue.ack([comment.id])
      log(`push ${comment.id}: put in front of ${to.slug} via ${how}`)
      // Name it the way its owner does, not by the directory — the whole point
      // of the pane name is telling three agents in one repo apart.
      const label = await herdrLabel(to).catch(() => null)
      claimed.pushedTo = { how, slug: sessionLabel({ ...to, ...(label?.name ? { pane_name: label.name } : {}) }), at: Date.now() }
      queue.save()
    } catch (e) {
      if (claimed) queue.unclaim(comment.id)
      log(`push ${comment.id}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    }
  }, 0)
}

/**
 * Live sessions, labelled the way their owner would recognise them.
 *
 * Two independent human names reach here — the herdr pane's, and the one the
 * person typed when they renamed the session — and neither is always present.
 * sessionLabel picks between them once, here, so the picker in the browser and
 * the `--sessions` listing in the terminal cannot disagree about what a session
 * is called. The status rides along too, because delivery is a pull: a session
 * that is idle gets the comment put in front of it immediately, one that is
 * running gets it at its next tool call, and the person choosing deserves to
 * know which they are picking.
 */
async function labelledSessions() {
  const live = registry.live()
  return Promise.all(live.map(async (s) => {
    const label = await herdrLabel(s).catch(() => null)
    const rec = label
      ? { ...s, ...(label.name ? { pane_name: label.name } : {}), ...(label.status ? { agent_status: label.status } : {}) }
      : s
    return { ...rec, label: sessionLabel(rec) }
  }))
}

/** @param {any} msg @returns {any | Promise<any>} */
function handle(msg) {
  const kind = String(msg?.kind ?? '')
  switch (kind) {
    case 'ping':
      return { ok: true, pid: process.pid }

    case 'session': {
      const rec = registry.touch(msg.session ?? {})
      return { ok: !!rec }
    }
    case 'session-gone':
      registry.forget(String(msg.session_id ?? ''))
      return { ok: true }

    case 'sessions':
      return labelledSessions().then((sessions) => ({ ok: true, sessions }))

    case 'comment': {
      const v = normalizeComment(msg.comment)
      if (!v.ok) return { ok: false, error: v.reason }

      // A browser has no working directory, so a comment arrives with routing
      // that is entirely the picker's choice. Two consequences had to be fixed
      // here, both of which lost real messages:
      //
      // 1. Stamp the chosen session's cwd onto the comment. Without it, a pick
      //    is the ONLY route, and when that session exits the comment has
      //    nothing to fall back to — measured: rwc-6 aimed at pid:2981, that
      //    process gone, and no session on the machine could ever claim it.
      // 2. Refuse what cannot be claimed. `target: null` with no cwd matches
      //    only when there is exactly one live session; with nineteen it
      //    matched nothing and sat queued forever looking like it had been
      //    sent. Silently accepting a message nobody will ever read is worse
      //    than saying no.
      const live = registry.live()
      const chosen = v.comment.target
        ? live.find((s) => s.session_id === v.comment.target || `pid:${s.pid}` === v.comment.target)
        : null
      if (chosen?.cwd && !v.comment.where.cwd) v.comment.where = { ...v.comment.where, cwd: chosen.cwd }
      // Refused only when the envelope carries NO routing at all — no session
      // and no directory. That is unroutable by construction, and the queue
      // would hold it for 48h looking sent. "Nobody is home right now" is a
      // different thing and is accepted: a session may open in that directory
      // a minute later, which is the whole point of a queue.
      if (!v.comment.target && !v.comment.where.cwd) {
        return { ok: false, error: live.length
          ? `pick which session gets this — ${live.length} are running and a browser has no directory to guess from`
          : 'no agent session is running' }
      }
      // A comment written mid-recording names a session directory whose
      // artifacts do not exist yet. Hold it until finishing says they do,
      // rather than handing an agent a path with nothing behind it.
      const held = !!v.comment.session?.recording
      const rec = queue.add(v.comment, { held })
      // A held comment has nothing to deliver yet; release pushes it.
      if (!held) push(rec)
      return { ok: true, id: rec.id, status: rec.status }
    }

    case 'release': {
      const released = queue.release(String(msg.dir ?? ''))
      for (const c of released) push(c)
      return { ok: true, released: released.map((c) => c.id) }
    }

    case 'claim': {
      const session = registry.touch(msg.session ?? {}) ?? msg.session ?? {}
      const live = registry.live()
      const claimed = queue.claim(session, live.length, Number(msg.max) || 4)
      return { ok: true, comments: claimed }
    }

    case 'ack':
      return { ok: true, acked: queue.ack(msg.ids) }

    case 'retarget': {
      const live = registry.live()
      const to = live.find((s) => s.session_id === msg.target || `pid:${s.pid}` === msg.target)
      if (!to) return { ok: false, error: `no live session "${msg.target}"` }
      const c = queue.retarget(String(msg.id ?? ''), to.session_id, to.cwd)
      if (!c) return { ok: false, error: 'no such comment' }
      push(c)
      return { ok: true, id: c.id, status: c.status, to: to.session_id }
    }

    case 'untarget': {
      const c = queue.untarget(String(msg.id ?? ''))
      return c ? { ok: true, id: c.id, status: c.status } : { ok: false, error: 'no such comment, or it had no target' }
    }

    case 'status':
      return labelledSessions().then((sessions) => ({ ok: true, pid: process.pid, sessions, comments: queue.list() }))

    case 'stop':
      setTimeout(() => shutdown(0), 30)
      return { ok: true }

    default:
      return { ok: false, error: `unknown kind "${kind}"` }
  }
}

const server = net.createServer((sock) => {
  let buf = ''
  sock.on('data', async (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let reply
      // Some handlers shell out (herdr, for the pane names in the picker), so a
      // reply may be a promise. Everything that a hook waits on — claim, ack,
      // session — stays synchronous.
      try { reply = await handle(JSON.parse(line)) }
      catch (e) { reply = { ok: false, error: e instanceof Error ? e.message : String(e) } }
      try { sock.write(JSON.stringify(reply) + '\n') } catch (e) {}
    }
  })
  sock.on('error', () => {})
})

server.on('error', (e) => { console.error(`rewalk hub: ${e.message}`); process.exit(1) })
server.listen(SOCK, () => {
  try { fs.chmodSync(SOCK, 0o600) } catch (e) {}
  console.log(`rewalk hub listening on ${SOCK}`)
})

/** @param {number} code */
function shutdown(code) {
  try { queue.save() } catch (e) {}
  try { server.close() } catch (e) {}
  try { fs.unlinkSync(SOCK) } catch (e) {}
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

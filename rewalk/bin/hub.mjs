#!/usr/bin/env node
// rewalk hub — the rendezvous between a browser and a coding-agent session.
//
// One process per user, started on demand (the SessionStart hook calls
// ensureHub, so nothing has to be remembered or added to login items). It
// listens on a unix socket in a 0700 directory and speaks one line of JSON per
// request. There is no HTTP surface and no token: the socket's directory mode
// plus Chrome's allowed_origins on the native host are the authorization.
//
// It does not push into sessions. Comments queue here and each agent claims
// what is addressed to it when its own lifecycle hooks give it a moment. A
// session that is idle fires no hooks, so its comments wait — that is the
// honest behavior, and the popup reports it rather than claiming delivery.
//
//   node bin/hub.mjs serve      run it (usually started for you)
//   node bin/hub.mjs status     what is queued, and who is live
//   node bin/hub.mjs stop       ask a running hub to exit
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { normalizeComment } from '../lib/comment.mjs'
import { hubCall, hubStateDir, sockPath } from '../lib/hub-wire.mjs'
import { Queue, SessionRegistry, matches } from '../lib/hub-state.mjs'
import { wake, herdrLabel } from '../lib/wake.mjs'

const verb = process.argv[2] ?? 'serve'

if (verb === 'status') {
  const r = await hubCall('status', {})
  if (!r) { console.log('no hub running'); process.exit(1) }
  const sessions = /** @type {any[]} */ (r.sessions ?? [])
  const comments = /** @type {any[]} */ (r.comments ?? [])
  console.log(`hub  pid ${r.pid}  socket ${sockPath()}`)
  console.log(`\n${sessions.length} live session(s):`)
  for (const s of sessions)
    console.log(`  ${s.session_id.padEnd(38)} ${String(s.agent).padEnd(7)} ${s.slug}  (${s.cwd})${s.discovered ? '  [discovered]' : ''}`)
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
const queue = new Queue(path.join(STATE, 'queue.json'))

// Nudge whichever live session this comment would go to, so an agent sitting
// at its prompt notices now rather than at the next thing a human types. Off
// the response path on purpose: shelling out to herdr takes the better part of
// a second and the browser is waiting on the queue, not on the nudge. The
// result is recorded on the comment so `--list` can say what happened.
/** @param {any} comment */
function nudge(comment) {
  setTimeout(async () => {
    try {
      const live = registry.live()
      const to = live.find((s) => matches(comment, s, live.length))
      if (!to) return
      const how = await wake(to)
      if (!how) return
      // Name it the way its owner does, not by the directory — the whole point
      // of the pane name is telling three agents in one repo apart.
      const label = await herdrLabel(to).catch(() => null)
      comment.woke = { how, slug: label?.name || to.slug, at: Date.now() }
      queue.save()
    } catch (e) {}
  }, 0)
}

/**
 * Live sessions, labelled the way their owner would recognise them.
 *
 * A herdr pane can be named, and that name is the only thing that tells three
 * agents in one repo apart — the picker showing a cwd basename gives three
 * identical rows. The status rides along too, because delivery is a pull: a
 * session that is idle takes the comment as soon as it is nudged, one that is
 * running takes it at its next tool call, and the person choosing deserves to
 * know which they are picking.
 */
async function labelledSessions() {
  const live = registry.live()
  return Promise.all(live.map(async (s) => {
    const label = await herdrLabel(s).catch(() => null)
    return label ? { ...s, ...(label.name ? { pane_name: label.name } : {}), ...(label.status ? { agent_status: label.status } : {}) } : s
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
      // A held comment has nothing to deliver yet; release does the waking.
      if (!held) nudge(rec)
      return { ok: true, id: rec.id, status: rec.status }
    }

    case 'release': {
      const released = queue.release(String(msg.dir ?? ''))
      for (const c of released) nudge(c)
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
      nudge(c)
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

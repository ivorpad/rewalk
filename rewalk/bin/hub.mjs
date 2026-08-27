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
import { Queue, SessionRegistry } from '../lib/hub-state.mjs'

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

/** @param {any} msg @returns {any} */
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
      return { ok: true, sessions: registry.live() }

    case 'comment': {
      const v = normalizeComment(msg.comment)
      if (!v.ok) return { ok: false, error: v.reason }
      // A comment written mid-recording names a session directory whose
      // artifacts do not exist yet. Hold it until finishing says they do,
      // rather than handing an agent a path with nothing behind it.
      const held = !!v.comment.session?.recording
      const rec = queue.add(v.comment, { held })
      return { ok: true, id: rec.id, status: rec.status }
    }

    case 'release': {
      const released = queue.release(String(msg.dir ?? ''))
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

    case 'untarget': {
      const c = queue.untarget(String(msg.id ?? ''))
      return c ? { ok: true, id: c.id, status: c.status } : { ok: false, error: 'no such comment, or it had no target' }
    }

    case 'status':
      return { ok: true, pid: process.pid, sessions: registry.live(), comments: queue.list() }

    case 'stop':
      setTimeout(() => shutdown(0), 30)
      return { ok: true }

    default:
      return { ok: false, error: `unknown kind "${kind}"` }
  }
}

const server = net.createServer((sock) => {
  let buf = ''
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let reply
      try { reply = handle(JSON.parse(line)) }
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

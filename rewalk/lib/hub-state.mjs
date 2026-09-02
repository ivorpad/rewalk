// The hub's state: which sessions are live, which comments are waiting, and
// what survives a restart.
//
// Two things here are deliberate departures from the system this is ported
// from (TAP):
//
// 1. **Claims are leased.** There, a claimed tap left the queue and never came
//    back except by restarting the hub — 18 of 25 stored taps were stuck in
//    "working" forever. A hook that dies between claiming and printing (or
//    whose output the harness drops) silently ate the message. Here `claim`
//    hands out a lease; the hook acks only after its stdout write succeeds, and
//    anything unacked returns to the queue when the lease expires.
//
// 2. **Comments can be held.** A comment written during a recording has no
//    artifacts to point at until that recording is finished. Held comments are
//    invisible to claims until `release` moves them to queued, which is what
//    the finish path calls once resolved.json and replay.html exist.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const SESSION_TTL_MS = 180_000
export const LEASE_MS = 60_000
export const KEEP_MS = 48 * 3600_000

/** @typedef {import('./comment.mjs').Comment} Comment */

/** @param {string} p */
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }

/** Signal 0: does that process still exist? @param {number} pid */
export function alive(pid) {
  if (!pid || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (e) { return false }
}

// --- session discovery -------------------------------------------------------
// Hook registration is the primary source; this covers sessions that started
// before the hooks were installed. Memoised, because a full sweep shells out
// once per process and the picker asks on every popup open.
let discoverCache = { at: 0, /** @type {any[]} */ list: [] }

/** @param {string} cmd @param {string[]} args */
function sh(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 }) }
  catch (e) { return '' }
}

/**
 * Working directories for many pids, in ONE lsof.
 *
 * This used to be one exec per pid. Each costs about 80ms, so twenty agent
 * sessions — an ordinary number on this machine — spent 1.6 seconds here, and
 * that was almost the entire cost of answering "who could receive a comment".
 * The native host gave the hub 2 seconds, so the browser's picker lost the race
 * and showed "no agent session is running" while twenty of them were running.
 *
 * `-Fpn` interleaves `p<pid>` and `n<path>` records, so the pid has to be
 * carried forward as the lines are read. Measured: 6 pids, 77ms.
 * @param {number[]} pids @returns {Map<number, string>}
 */
function cwdsOf(pids) {
  /** @type {Map<number, string>} */
  const out = new Map()
  if (!pids.length) return out
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try { out.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`)) } catch (e) {}
    }
    return out
  }
  let pid = 0
  for (const line of sh('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn']).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0
    else if (line.startsWith('n') && pid) { out.set(pid, line.slice(1)); pid = 0 }
  }
  return out
}

/** Sessions found by sweeping processes, for agents that never fired a hook. */
export function discoverSessions() {
  if (Date.now() - discoverCache.at < 10_000) return discoverCache.list
  const home = os.homedir()
  /** @type {{agent: string, pid: number}[]} */
  const found = []
  for (const agent of ['claude', 'codex'])
    for (const raw of sh('pgrep', ['-x', agent]).split('\n')) {
      const pid = Number(raw.trim())
      if (pid) found.push({ agent, pid })
    }
  const cwds = cwdsOf(found.map((f) => f.pid))
  const out = []
  for (const { agent, pid } of found) {
    const cwd = cwds.get(pid) ?? ''
    // A helper or MCP server sitting in / or $HOME is not somebody's session.
    if (!cwd || cwd === '/' || cwd === home) continue
    out.push({ session_id: `pid:${pid}`, agent, cwd, slug: path.basename(cwd), title: '', pid,
      event: '', last_seen: Date.now() / 1000, idle_for: null, discovered: true })
  }
  discoverCache = { at: Date.now(), list: out }
  return out
}

// --- live sessions -----------------------------------------------------------
export class SessionRegistry {
  /** @param {string} mirrorDir */
  constructor(mirrorDir) {
    this.mirror = mirrorDir
    /** @type {Map<string, any>} */
    this.byId = new Map()
    fs.mkdirSync(mirrorDir, { recursive: true, mode: 0o700 })
    // Files left by sessions that died without saying goodbye.
    for (const f of fs.readdirSync(mirrorDir)) {
      const p = path.join(mirrorDir, f)
      try { if (Date.now() - fs.statSync(p).mtimeMs > SESSION_TTL_MS) fs.unlinkSync(p) } catch (e) {}
    }
  }

  /** Register or refresh. Every hook calls this, so it must stay cheap. */
  touch(payload) {
    const id = String(payload?.session_id ?? '').trim()
    if (!id) return null
    const rec = {
      session_id: id,
      agent: String(payload.agent ?? 'claude').slice(0, 32),
      cwd: String(payload.cwd ?? ''),
      slug: String(payload.slug ?? path.basename(String(payload.cwd ?? ''))).slice(0, 60),
      // What its owner renamed the session to, separate from the directory it
      // sits in. One field carrying both meant a picker could not tell a
      // deliberate name from a coincidence of paths.
      title: String(payload.title ?? '').slice(0, 60),
      pid: Number(payload.pid ?? 0) || 0,
      // The terminal this session sits in, so an idle one can be nudged. Only
      // the session's own environment knows this, and an idle session fires no
      // hooks to be asked later.
      pane: String(payload.pane ?? '').slice(0, 64),
      tmux_pane: String(payload.tmux_pane ?? '').slice(0, 64),
      tmux_socket: String(payload.tmux_socket ?? '').slice(0, 256),
      event: String(payload.event ?? '').slice(0, 32),
      last_seen: Date.now() / 1000,
    }
    // SessionStart knows the cwd; a bare drain may not, and must not blank out
    // what registration already established.
    const prior = this.byId.get(id)
    if (prior) for (const k of ['cwd', 'slug', 'title', 'pid', 'pane', 'tmux_pane', 'tmux_socket']) if (!rec[k]) rec[k] = prior[k] ?? ''
    this.byId.set(id, rec)
    try {
      const tmp = path.join(this.mirror, `${id}.tmp`)
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n')
      fs.renameSync(tmp, path.join(this.mirror, `${id}.json`))
    } catch (e) {}
    return rec
  }

  /** @param {string} id */
  forget(id) {
    this.byId.delete(id)
    try { fs.unlinkSync(path.join(this.mirror, `${id}.json`)) } catch (e) {}
  }

  /**
   * Sessions a comment could go to right now. Liveness is the process, not the
   * clock: an agent sitting at its prompt fires no hooks, and expiring it after
   * three minutes would drop exactly the sessions most able to take work.
   */
  live() {
    const cutoff = Date.now() / 1000 - SESSION_TTL_MS / 1000
    const fresh = []
    for (const [id, rec] of [...this.byId]) {
      const ok = rec.pid ? alive(rec.pid) : rec.last_seen >= cutoff
      if (ok) fresh.push({ ...rec, idle_for: +(Date.now() / 1000 - rec.last_seen).toFixed(1) })
      else { this.byId.delete(id); try { fs.unlinkSync(path.join(this.mirror, `${id}.json`)) } catch (e) {} }
    }
    fresh.sort((a, b) => b.last_seen - a.last_seen)
    // Registered wins over discovered, matched by pid.
    const pids = new Set(fresh.map((r) => r.pid).filter(Boolean))
    return [...fresh, ...discoverSessions().filter((d) => !pids.has(d.pid))]
  }
}

// --- what to call a session --------------------------------------------------
// Three independent names arrive for one session and they do not agree:
//
//   pane_name  what the terminal pane is called (lib/wake.mjs, from herdr)
//   title      what its owner renamed the session to (bin/hook.mjs)
//   slug       the basename of its working directory
//
// A pane that has never been named carries the agent's own name, which tells
// nobody anything: three claudes in one repo are three rows reading "claude".
// So a REAL pane name wins — somebody typed it about this pane — a default one
// steps aside for the rename, and the directory is the floor.
const DEFAULT_PANE = /^(claude|codex)(?:[\s._-]*\d+)?$/i

/** @param {any} s */
export function sessionLabel(s) {
  const pane = String(s?.pane_name ?? '').trim()
  const named = pane && !DEFAULT_PANE.test(pane) ? pane : ''
  return named || String(s?.title ?? '').trim() || String(s?.slug ?? '').trim() || pane || String(s?.cwd ?? '')
}

// --- routing -----------------------------------------------------------------
/** macOS /tmp is a symlink to /private/tmp: compare real paths or a correct
 * route looks like a hook that never fired. @param {string} a @param {string} b */
export function sameDir(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch (e) { return path.normalize(a) === path.normalize(b) }
}

/**
 * Does this waiting comment belong to this session? Narrowest first: an
 * explicit pick from the picker always wins, then the directory, then "there
 * is only one session". A comment that matches nothing keeps waiting rather
 * than landing somewhere surprising.
 * @param {Comment} c @param {any} session @param {number} liveCount
 */
export function matches(c, session, liveCount) {
  if (c.target) {
    if (c.target === session.session_id || c.target === `pid:${session.pid ?? 0}`) return true
    // A pick at a process that no longer exists cannot be honoured, and a
    // comment nobody can ever claim is worse than one delivered to the session
    // sitting in the same directory. Only a DEAD target is overridden — a live
    // one that simply has not worked yet keeps waiting, because second-guessing
    // the human's pick is how you stop trusting the router.
    const pid = /^pid:(\d+)$/.exec(c.target)
    if (pid && alive(Number(pid[1]))) return false
    if (!pid) return false
  }
  const cwd = c.where?.cwd
  if (cwd && session.cwd) return sameDir(cwd, session.cwd)
  return liveCount === 1
}

// --- the queue ---------------------------------------------------------------
export class Queue {
  /** @param {string} file @param {string} [envelopeDir] */
  constructor(file, envelopeDir) {
    this.file = file
    // Where each comment's full envelope is written as its own JSON file. The
    // rendered block is prose — readable, and lossy: snippets are trimmed, pick
    // times and the raw React props are not in it, and a comment made with no
    // recording has nothing else on disk at all. An agent debugging one needs
    // the actual object, so it gets a path to it.
    this.envelopeDir = envelopeDir ?? path.join(path.dirname(file), 'comments')
    /** @type {Map<string, any>} */
    this.byId = new Map()
    this.seq = 0
    this.load()
  }

  load() {
    const raw = readJson(this.file)
    if (!raw?.comments) return
    const cutoff = Date.now() - KEEP_MS
    for (const c of raw.comments) {
      if (!c?.id || (c.createdWall ?? 0) < cutoff) continue
      // Anything the previous hub had handed out is not going to be finished by
      // whoever had it. Requeue rather than leave it stuck working forever.
      if (c.status === 'claimed') { c.status = 'queued'; delete c.leaseUntil; delete c.claimedBy }
      this.byId.set(c.id, c)
      const n = Number(String(c.id).replace(/^rwc-/, ''))
      if (Number.isFinite(n)) this.seq = Math.max(this.seq, n)
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, comments: [...this.byId.values()] }))
      fs.renameSync(tmp, this.file)
    } catch (e) {}   // a queue we cannot mirror is still a queue that works
  }

  /**
   * @param {Comment} comment
   * @param {{held?: boolean}} [opts]
   */
  add(comment, { held = false } = {}) {
    const id = `rwc-${++this.seq}`
    const rec = { ...comment, id, status: held ? 'held' : 'queued' }
    // Written before anything is told about the comment, so the path in the
    // rendered block is always readable by the time an agent sees it.
    try {
      fs.mkdirSync(this.envelopeDir, { recursive: true, mode: 0o700 })
      const p = path.join(this.envelopeDir, `${id}.json`)
      fs.writeFileSync(p, JSON.stringify({ ...comment, id }, null, 1) + '\n')
      rec.envelope = p
    } catch (e) {}
    this.byId.set(id, rec)
    this.save()
    return rec
  }

  /** Held -> queued for every comment of a session that just finished. */
  release(dir) {
    const out = []
    for (const c of this.byId.values()) {
      if (c.status !== 'held' || c.session?.dir !== dir) continue
      c.status = 'queued'
      out.push(c)
    }
    if (out.length) this.save()
    return out
  }

  /** Leases that ran out come back. Called before every claim. */
  sweep() {
    let changed = false
    for (const c of this.byId.values()) {
      if (c.status === 'claimed' && (c.leaseUntil ?? 0) < Date.now()) {
        c.status = 'queued'; delete c.leaseUntil; delete c.claimedBy; changed = true
      }
      if ((c.createdWall ?? 0) < Date.now() - KEEP_MS) { this.byId.delete(c.id); changed = true }
    }
    if (changed) this.save()
  }

  /**
   * @param {any} session @param {number} liveCount @param {number} max
   * @returns {any[]}
   */
  claim(session, liveCount, max = 4) {
    this.sweep()
    const out = []
    for (const c of this.byId.values()) {
      if (out.length >= max) break
      if (c.status !== 'queued') continue
      if (!matches(c, session, liveCount)) continue
      c.status = 'claimed'
      c.claimedBy = session.session_id
      c.leaseUntil = Date.now() + LEASE_MS
      out.push(c)
    }
    if (out.length) this.save()
    return out
  }

  /**
   * Take one specific comment out of the queue for a session, so it can be put
   * straight into that session's prompt instead of waiting for a hook.
   *
   * This is the SAME claim the hook competes for, which is what makes injecting
   * the content safe: whoever claims it first is the only one who delivers it.
   * Returns null when it is not claimable — already claimed, already delivered,
   * still held by a recording — and `release()` puts it back if the injection
   * then fails.
   * @param {string} id @param {string} sessionId
   */
  claimOne(id, sessionId) {
    this.sweep()
    const c = this.byId.get(id)
    if (!c || c.status !== 'queued') return null
    c.status = 'claimed'
    c.claimedBy = sessionId
    c.leaseUntil = Date.now() + LEASE_MS
    this.save()
    return c
  }

  /** Put a claim back, for an injection that did not land. */
  unclaim(id) {
    const c = this.byId.get(id)
    if (!c || c.status !== 'claimed') return
    c.status = 'queued'
    delete c.leaseUntil
    delete c.claimedBy
    this.save()
  }

  /** The hook confirming it printed them. Unacked claims expire and requeue. */
  ack(ids) {
    let n = 0
    for (const id of ids ?? []) {
      const c = this.byId.get(id)
      if (!c || c.status !== 'claimed') continue
      c.status = 'delivered'
      c.deliveredWall = Date.now()
      delete c.leaseUntil
      n++
    }
    if (n) this.save()
    return n
  }

  /**
   * Point a comment at a different session, stamping that session's directory
   * so it still has somewhere to go if the session later exits.
   */
  retarget(id, target, cwd) {
    const c = this.byId.get(id)
    if (!c) return null
    c.target = target || null
    if (cwd) c.where = { ...c.where, cwd }
    if (c.status === 'held') c.status = 'queued'
    this.save()
    return c
  }

  /** Clear a comment's explicit target so it routes by directory instead. */
  untarget(id) {
    const c = this.byId.get(id)
    if (!c || !c.target) return null
    c.target = null
    if (c.status === 'held') c.status = 'queued'
    this.save()
    return c
  }

  /** @param {{status?: string}} [filter] */
  list(filter = {}) {
    this.sweep()
    return [...this.byId.values()].filter((c) => !filter.status || c.status === filter.status)
  }
}

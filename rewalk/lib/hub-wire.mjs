// Talking to the hub: one line of JSON in, one line of JSON out, over a unix
// socket in a 0700 directory. No HTTP, no token — authorization is the socket
// dir's mode plus Chrome's allowed_origins on the native host, the same model
// TAP settled on. The path stays short on purpose: macOS caps AF_UNIX paths
// near 104 bytes, and a config-dir path under a long home already hit that
// ceiling in TAP's history.
//
// Everything here is also imported by bin/hook.mjs, which runs before and
// after every tool call of every agent session. Keep the import list to
// node builtins; the render path loads lazily elsewhere.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** @returns {string} */
export function sockPath() {
  if (process.env.REWALK_HUB_SOCK) return process.env.REWALK_HUB_SOCK
  return path.join(`/tmp/rw-${os.userInfo().username}`, 'hub.sock')
}

/** State that outlives a hub restart: the queue mirror and the session mirror. */
export function hubStateDir() {
  const cfg = process.env.REWALK_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'rewalk')
  return path.join(cfg, 'hub')
}

/**
 * One request, one reply, or null. Null covers every way there can be no hub:
 * no socket file, a stale socket a killed hub left behind, a hub mid-restart.
 * Callers treat null as "nothing waiting" — a hook that raises wedges the
 * agent it was meant to help.
 * @param {string} kind
 * @param {object} [payload]
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export function hubCall(kind, payload = {}, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const p = sockPath()
    if (!fs.existsSync(p)) return resolve(null)
    /** @type {net.Socket} */
    let sock
    try { sock = net.connect(p) } catch (e) { return resolve(null) }
    let buf = ''
    let done = false
    /** @param {Record<string, unknown> | null} v */
    const finish = (v) => { if (!done) { done = true; try { sock.destroy() } catch (e) {} resolve(v) } }
    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref?.()
    sock.on('connect', () => {
      try { sock.write(JSON.stringify({ kind, ...payload }) + '\n') } catch (e) { finish(null) }
    })
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      try { finish(JSON.parse(buf.slice(0, nl))) } catch (e) { finish(null) }
    })
    sock.on('error', () => { clearTimeout(timer); finish(null) })
    sock.on('close', () => { clearTimeout(timer); finish(null) })
  })
}

/** @returns {Promise<boolean>} */
export async function hubAlive() {
  return (await hubCall('ping', {}, { timeoutMs: 1000 })) != null
}

/**
 * Start the hub if nobody has. A connect test, never a stat: the socket file
 * outlives any hub that was killed rather than asked to stop, and trusting a
 * stat means never starting again after the first hard kill.
 *
 * Racing callers are fine — the hub pings before binding and exits when a
 * sibling answers, so whichever bind wins is the one everybody talks to.
 * @param {{waitMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function ensureHub({ waitMs = 5000 } = {}) {
  if (await hubAlive()) return true
  try {
    spawn(process.execPath, [path.join(ROOT, 'bin', 'hub.mjs'), 'serve'], {
      detached: true, stdio: 'ignore',
    }).unref()
  } catch (e) { return false }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await hubAlive()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

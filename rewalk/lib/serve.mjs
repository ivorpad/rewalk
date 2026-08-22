// Serve fixtures/ so the entry points work on a fresh clone.
//
// Every bin in this repo defaults to http://127.0.0.1:51931/<fixture>, and
// nothing in the repo ever started that server. It worked because a
// `python3 -m http.server 51931` left running in fixtures/ by hand, in some
// earlier session, happened to still be alive -- an undeclared dependency on a
// process nobody wrote down. Clone this repo and every one of `lab`, `check`,
// `watch` and `beacon-smoke` fails at page load, and the failure arrives as an
// empty recording rather than as "there is no server".
//
// The fixtures must be served rather than opened as file:// URLs: rrweb's
// snapshot inlines stylesheets by reading document.styleSheets, and a file://
// page cannot read its own subresources under Chromium's origin rules.

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_PORT = Number(process.env.REWALK_PORT ?? 51931)
export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wav': 'audio/wav', '.png': 'image/png', '.svg': 'image/svg+xml' }

function listening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host })
    const done = (v) => { s.destroy(); resolve(v) }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    setTimeout(() => done(false), 400)
  })
}

/**
 * Make sure something is serving the fixtures, and return a stop function.
 *
 * If a server is already up on the port -- the hand-started one, or another
 * bin in the same workflow -- it is left alone and stop() is a no-op. Two
 * processes fighting over one port is worse than reusing whatever is there.
 */
export async function ensureFixtureServer({ port = FIXTURE_PORT, dir = FIXTURE_DIR } = {}) {
  if (await listening(port)) return { started: false, port, url: (f) => `http://127.0.0.1:${port}/${f}`, stop: () => {} }
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '')
    // Contain the path: a fixture server that will read ../../.ssh is a
    // liability even bound to loopback.
    const file = path.resolve(dir, rel || 'index.html')
    if (!file.startsWith(path.resolve(dir))) { res.writeHead(403).end('no'); return }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store' })
      res.end(buf)
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  server.unref()
  return { started: true, port, url: (f) => `http://127.0.0.1:${port}/${f}`,
    stop: () => new Promise((r) => server.close(r)) }
}

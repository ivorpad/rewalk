// Single point of contact with the scripted-walk engine.
//
// The engine is `web-qa` folded into this repo: qa.mjs is `rewalk run`/`check`
// with a different front end, not something we shell out to.
//
// It lives inside skill/ rather than beside it because that directory ships.
// A skill is copied to another machine whole, so anything it needs at runtime
// has to travel with it — splitting the scripts out left a SKILL.md naming an
// absolute path that existed on exactly one computer. When the CLI is
// installable this inverts: the skill shrinks to invoking `rewalk` and the
// scripts move back out.
//
// Everything that needs the engine still goes through this file, so pointing
// it somewhere else stays a one-line change.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ENGINE = process.env.REWALK_ENGINE ?? join(HERE, '..', 'skill')
export const chromiumPath = join(ENGINE, 'node_modules/playwright/index.mjs')
export const rrwebUmd = join(ENGINE, 'node_modules/rrweb/dist/rrweb.umd.min.cjs')
export const recordScript = join(ENGINE, 'scripts/rrweb-record.js')
export const viewerTemplate = join(ENGINE, 'assets/viewer.template.html')
export const loadChromium = async () => (await import(chromiumPath)).chromium

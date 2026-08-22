// Single point of contact with the scripted-walk engine.
//
// The engine is `web-qa` folded into this repo: qa.mjs is `rewalk run`/`check`
// with a different front end, not something we shell out to. It kept its own
// package.json because Playwright and rrweb are its dependencies, not the
// CLI's, and because `npx playwright install` wants to own that tree.
//
// Everything that needs the engine still goes through this file, so pointing
// it somewhere else stays a one-line change.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ENGINE = process.env.REWALK_ENGINE ?? join(HERE, '..', 'engine')
export const chromiumPath = join(ENGINE, 'node_modules/playwright/index.mjs')
export const rrwebUmd = join(ENGINE, 'node_modules/rrweb/dist/rrweb.umd.min.cjs')
export const recordScript = join(ENGINE, 'scripts/rrweb-record.js')
export const viewerTemplate = join(ENGINE, 'assets/viewer.template.html')
export const loadChromium = async () => (await import(chromiumPath)).chromium

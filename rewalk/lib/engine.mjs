// Single point of contact with the scripted-walk engine.
//
// Playwright and rrweb currently live in ~/.claude/skills/web-qa/node_modules.
// That tree is being folded into this repo (qa.mjs becomes `rewalk run`/`check`
// rather than something we shell out to), and work in flight still imports from
// the old path, so the move cannot happen yet. Everything that needs the engine
// goes through here, so when it does move this is the only file that changes.
export const ENGINE = process.env.REWALK_ENGINE ?? '/Users/ivor/.claude/skills/web-qa'
export const chromiumPath = `${ENGINE}/node_modules/playwright/index.mjs`
export const rrwebUmd = `${ENGINE}/node_modules/rrweb/dist/rrweb.umd.min.cjs`
export const loadChromium = async () => (await import(chromiumPath)).chromium

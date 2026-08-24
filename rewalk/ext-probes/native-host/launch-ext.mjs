#!/usr/bin/env node
// launch-ext.mjs — load the probe extension into Playwright's Chromium so its
// service worker calls connectNative('com.rewalk.probe'), which makes Chrome
// spawn capture-host.sh. The host writes result.json with the TCC verdict.
//
// PREREQUISITE (blocked from the agent by the safety classifier; a human must
// run install.sh first): the wrapper must be executable and the host manifest
// must be installed under the browser's NativeMessagingHosts dir.
//
// SAFETY: this launches a HEADFUL browser. Watch the screen. If a macOS
// microphone permission dialog appears, DO NOT CLICK IT — note which app it
// names and Ctrl-C. The prompt-or-not is itself the experimental result.
//
//   node launch-ext.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChromium } from '../../lib/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXT = path.join(HERE, 'ext-probe')
const RESULT = path.join(HERE, 'result.json')
const chromium = await loadChromium()

try { fs.unlinkSync(RESULT) } catch (e) {}
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewalk-tcc-udd-'))

console.log('[launch] extension:', EXT)
console.log('[launch] user-data-dir:', userDataDir)
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
  ],
})

// Surface the service worker's console so connectNative failures are visible.
ctx.on('serviceworker', (sw) => {
  console.log('[launch] service worker:', sw.url())
})
for (const sw of ctx.serviceWorkers()) console.log('[launch] existing SW:', sw.url())

const page = await ctx.newPage()
await page.goto('about:blank')

console.log('[launch] waiting up to 25s for the host to write result.json ...')
const deadline = Date.now() + 25_000
let result = null
while (Date.now() < deadline) {
  if (fs.existsSync(RESULT)) {
    try { result = JSON.parse(fs.readFileSync(RESULT, 'utf8')); break } catch (e) { /* mid-write */ }
  }
  await new Promise((r) => setTimeout(r, 300))
}

if (result) {
  console.log('\n=== HOST RESULT (Chrome-spawned) ===')
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log('\n[launch] NO result.json — the host was never spawned or never replied.')
  console.log('[launch] Check: manifest installed for THIS browser product? wrapper executable?')
  console.log('[launch] capture-host.log:', path.join(HERE, 'capture-host.log'))
}

await new Promise((r) => setTimeout(r, 1000))
await ctx.close()
try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch (e) {}
process.exit(result && result.ok ? 0 : 1)

// The lens, asserted against the real bundle.
//
// There were two overlays until this check existed, and nothing tested either
// of them. Each assertion here is a bug that shipped:
//
//   - the comment overlay ringed the literal event target while the recorder
//     marked closest(INTERACTIVE), so clicking the <svg> inside a close button
//     filed a comment about the <svg>
//   - the pointing lens assumed position:fixed worked, and never called the
//     measurement fallback the comment overlay had, so its ring sat hundreds of
//     pixels away on any page with a transform on <html>
//   - the comment overlay shipped react: null while the ring beside it was
//     naming the component, because the fiber walk is in the other world
//
// The page is deliberately hostile: a transform on <html> (which makes it the
// containing block for every fixed descendant) and enough height to scroll.
//
//   node bin/lens-check.mjs

import http from 'node:http'
import { loadChromium } from '../lib/engine.mjs'
import { bootScript, lensScript } from '../lib/record.mjs'

const PAGE = `<!doctype html>
<html style="transform: translateZ(0)">
<body style="font:14px system-ui;padding:20px;height:3000px">
<div style="height:600px">scroll spacer</div>
<button id="close-btn" aria-label="Close" style="padding:10px">
  <svg id="the-svg" width="16" height="16" viewBox="0 0 24 24"><path d="M6 6l12 12"/></svg>
</button>
<div id="plain-box" style="width:200px;height:40px;background:#eee;margin-top:40px">plain</div>
</body></html>`

const server = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end(PAGE) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const chromium = await loadChromium()
const events = []
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } })
await ctx.exposeBinding('__rewalkEmit', (_s, b) => events.push(...b))
await ctx.addInitScript(bootScript({ mask: false, hud: true }))
const page = await ctx.newPage()
await page.goto(base, { waitUntil: 'load' })
await page.waitForTimeout(900)
// A recording draws NOTHING until somebody asks for it — Tab, handled in
// lib/highlight.js and relayed by lib/frames.js. Without this every assertion
// below fails on an overlay that is correctly refusing to exist. Asserted the
// other way round in bin/ext-check.mjs, which owns that behaviour.
await page.keyboard.press('Tab')
await page.waitForTimeout(200)
await page.evaluate(() => window.scrollTo(0, 400))
await page.waitForTimeout(300)

const fail = []
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail ?? ''}`)
  if (!cond) fail.push(name)
}

// --- which element ----------------------------------------------------------
// Hover the <svg> INSIDE the close button. The ring must name the button: that
// is what a mark records, and what a comment must therefore also record.
const svg = await page.locator('#the-svg').boundingBox()
await page.mouse.move(svg.x + svg.width / 2, svg.y + svg.height / 2)
await page.waitForTimeout(300)
const hovered = await page.evaluate(() => window.__rewalkHl.probe())
// selector.js prefers a unique #id over [aria-label], so the button's name is
// #close-btn. What matters is that it is the BUTTON and not #the-svg.
ok('ring lands on closest(INTERACTIVE)', hovered.target === '#close-btn', `ring on ${hovered.target}`)

// --- where the ring lands ---------------------------------------------------
ok('host falls back to absolute under a transform', hovered.host.position === 'absolute',
  `position: ${hovered.host.position}`)
ok('host is exactly the viewport',
  Math.abs(hovered.host.h - hovered.viewport.h) <= 1 && Math.abs(hovered.host.y) <= 1,
  `host ${hovered.host.w}x${hovered.host.h} at y=${hovered.host.y}, viewport h=${hovered.viewport.h}`)

// --- the mark agrees with the ring ------------------------------------------
await page.mouse.click(svg.x + svg.width / 2, svg.y + svg.height / 2)
await page.waitForTimeout(500)
await page.evaluate(() => window.__rrFlush?.())
await page.waitForTimeout(300)
const marks = events.filter((e) => e.type === 5 && e.data?.tag === 'rewalk-mark')
ok('one mark per click', marks.length === 1, `${marks.length} mark(s)`)
ok('the mark names what the ring named', marks[0]?.data?.payload?.s === hovered.target,
  `mark s=${marks[0]?.data?.payload?.s}`)

// --- the cross-world react bridge -------------------------------------------
// The responder is in tick.js (MAIN). This is the exact round trip the ISOLATED
// comment overlay makes, including that it resolves before dispatch returns.
const bridge = await page.evaluate(() => {
  let answer = 'NEVER-CALLED'
  const onA = (e) => { try { answer = JSON.parse(e.detail) } catch (x) { answer = 'BAD-JSON' } }
  document.addEventListener('__rewalk_react_a', onA)
  document.getElementById('close-btn')
    .dispatchEvent(new CustomEvent('__rewalk_react_q', { detail: 'tok-1', bubbles: true }))
  document.removeEventListener('__rewalk_react_a', onA)
  return answer
})
ok('react question answered synchronously', !!bridge && bridge.token === 'tok-1',
  `answer ${JSON.stringify(bridge)}`)

// --- still invisible to the recorder ----------------------------------------
const stream = JSON.stringify(events)
ok('the lens never enters the recording',
  !stream.includes('rewalk-lens') && !stream.includes('rewalk-hud-hl'), 'no instrument id in the stream')

// A non-interactive element is ringed as itself: pickTarget falling back to the
// literal element.
const plain = await page.locator('#plain-box').boundingBox()
await page.mouse.move(plain.x + 20, plain.y + 20)
await page.waitForTimeout(250)
const elsewhere = await page.evaluate(() => window.__rewalkHl.probe())
ok('a non-interactive element is ringed as itself', elsewhere.target === '#plain-box',
  `now ${elsewhere.target}`)

await browser.close()

// --- part two: a frame below the top one ------------------------------------
// Injected the way the extension does it, which is the whole point: the
// recorder TOP ONLY (one rrweb per tab) and the lens EVERYWHERE (rects are
// per-frame). Before this split, two clicks inside a same-origin iframe
// produced zero marks and no ring.
console.log('\n--- inside an iframe ---')

const CHILD = `<!doctype html><body style="font:14px system-ui;padding:20px">
<button id="kid-btn" aria-label="Close">
  <svg id="kid-svg" width="16" height="16" viewBox="0 0 24 24"><path d="M6 6l12 12"/></svg>
</button></body>`
const HOST = `<!doctype html><body style="font:14px system-ui;padding:20px">
<button id="top-btn">top</button>
<iframe id="story" src="/child" style="width:600px;height:300px;border:1px solid #333"></iframe>
</body>`

const server2 = http.createServer((q, s) => {
  s.writeHead(200, { 'content-type': 'text/html' })
  s.end(q.url.startsWith('/child') ? CHILD : HOST)
})
await new Promise((r) => server2.listen(0, '127.0.0.1', r))
const base2 = `http://127.0.0.1:${server2.address().port}`

const ev2 = []
const b2 = await chromium.launch({ headless: true })
const c2 = await b2.newContext({ viewport: { width: 1000, height: 700 } })
await c2.exposeBinding('__rewalkEmit', (_s, b) => ev2.push(...b))
// Exactly what bin/watch.mjs does. bootScript is frame aware — the lens half
// runs everywhere, the recorder half returns immediately below the top frame —
// but a ~320KB init script never reaches a child frame at all, so the lens is
// injected into child frames explicitly. The extension has neither problem: it
// registers boot.main.js allFrames:false and lens.main.js allFrames:true.
await c2.addInitScript(bootScript({ mask: false, hud: true }))
const p2 = await c2.newPage()
const lensJs = lensScript()
const lensFrame = (f) => { if (f !== p2.mainFrame() && !f.isDetached()) f.evaluate(lensJs).catch(() => {}) }
p2.on('framenavigated', lensFrame)
p2.on('frameattached', lensFrame)
await p2.goto(base2, { waitUntil: 'load' })
for (const f of p2.frames()) lensFrame(f)
await p2.waitForTimeout(1200)
// Ask for the instruments. Pressed in the TOP frame; lib/frames.js relays it
// down, which is the only way a child frame's lens ever arms — and a child that
// stays disarmed records no marks at all, which is what the four assertions
// below would otherwise be quietly measuring.
await p2.keyboard.press('Tab')
await p2.waitForTimeout(300)

const kid = p2.frameLocator('#story').locator('#kid-svg')
await kid.click()
await p2.waitForTimeout(300)
await kid.click({ modifiers: ['Alt'] })
await p2.waitForTimeout(400)
await p2.locator('#top-btn').click()
await p2.waitForTimeout(600)
await p2.evaluate(() => window.__rrFlush?.())
await p2.waitForTimeout(400)

const m2 = ev2.filter((e) => e.type === 5 && e.data?.tag === 'rewalk-mark').map((e) => e.data.payload)
const fromFrame = m2.filter((m) => m.frame)
const snaps = ev2.filter((e) => e.type === 2)

ok('one rrweb recorder for the whole tab', snaps.length === 1, `${snaps.length} full snapshot(s)`)
ok('clicks inside the frame are recorded', fromFrame.length === 2, `${fromFrame.length} of 2`)
ok('a frame mark names closest(INTERACTIVE)', fromFrame[0]?.s === '#kid-btn', `s=${fromFrame[0]?.s}`)
ok('a frame mark says which frame', (fromFrame[0]?.frame?.url ?? '').endsWith('/child'),
  `frame=${fromFrame[0]?.frame?.url}`)
ok('alt-click inside the frame is a point', fromFrame[1]?.kind === 'point', `kind=${fromFrame[1]?.kind}`)
ok('the top frame still marks its own clicks once',
  m2.filter((m) => !m.frame).length === 1, `${m2.filter((m) => !m.frame).length} top mark(s)`)
ok('the lens draws inside the frame', await p2.frames()
  .find((f) => f.url().endsWith('/child'))
  .evaluate(() => !!window.__rewalkHl), 'child frame has a lens')

await b2.close()

// --- part three: nobody asked ------------------------------------------------
// The lens bundle is injected on its own when someone opens the comment overlay,
// because the fiber walk only exists in this world. On a page with no recording
// it must put NOTHING in the document and draw nothing, however much the pointer
// moves. An overlay that appears without being asked for is the whole complaint.
console.log('\n--- no recording running ---')

const b3 = await chromium.launch({ headless: true })
const c3 = await b3.newContext({ viewport: { width: 900, height: 600 } })
await c3.addInitScript(lensScript())          // the lens ALONE: no recorder at all
const p3 = await c3.newPage()
await p3.goto(base2, { waitUntil: 'load' })
await p3.waitForTimeout(500)
await p3.mouse.move(120, 60)
await p3.mouse.move(200, 90)
await p3.waitForTimeout(400)

const quiet = await p3.evaluate(() => ({
  loaded: typeof window.__rewalkHl,
  react: typeof window.__rewalkReact,
  host: !!document.getElementById('rewalk-lens'),
  probe: window.__rewalkHl?.probe?.() ?? null,
}))
ok('the bundle still loads (the fiber walk is why)', quiet.loaded === 'object' && quiet.react === 'function',
  `hl=${quiet.loaded} react=${quiet.react}`)
ok('no host element is created', quiet.host === false, `#rewalk-lens present: ${quiet.host}`)
ok('the lens reports itself closed', quiet.probe?.open === false, `probe=${JSON.stringify(quiet.probe)}`)

await b3.close()
server2.close()
server.close()
const total = 18
console.log(`\n${fail.length ? `FAILED: ${fail.join(', ')}` : `all ${total}/${total} lens checks passed`}`)
process.exit(fail.length ? 1 : 0)

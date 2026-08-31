// The extension, asserted as a LOADED EXTENSION.
//
// Everything else in this repo tests a program that resembles the one people
// click. bin/lens-check.mjs drives an init script in a plain page; the lab and
// the falsifier drive the CLI. None of them exercises chrome.scripting, the
// MAIN/ISOLATED split, the service-worker message API, chrome.storage, the
// popup, or the native port — and every bug a person has actually hit in this
// product lived in exactly that layer, invisible to a fully green suite:
//
//   - registrations that outlived the browser, instrumenting pages nobody
//     asked about, with the HUD and a live rrweb writing into nothing
//   - startSession dying on a duplicate-id throw: no HUD, no badge, no error,
//     and a microphone running for a recording that did not exist
//   - the comment target living in a content-script variable, so it died with
//     the page and the next comment went wherever the hub happened to list
//     first
//
// So this loads chrome-ext/ unpacked, exactly as `Load unpacked` does, and
// drives it.
//
// Two things make it possible at all:
//
//   channel: 'chromium'.  Playwright's default headless build is the headless
//   SHELL, which cannot load extensions at all — the extension silently does
//   not exist and every assertion fails for the wrong reason.
//
//   A fake native port.  chrome.runtime.connectNative is replaced INSIDE the
//   service worker, so everything above the pipe is the real code — start,
//   stop, the registration lifecycle, storage, the comment envelope — and the
//   only thing stubbed is the process on the other end. Nothing here touches
//   the real hub, the real queue, or a microphone.
//
// What it still cannot see: the panel is a closed shadow root in the ISOLATED
// world, which Playwright has no API for, so the UI is read through
// window.__rewalkAnnotate.probe() via chrome.scripting.executeScript — the
// extension asking itself.
//
//   node bin/ext-check.mjs           headless
//   HEAD=1 node bin/ext-check.mjs    watch it happen
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChromium } from '../lib/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXT = path.resolve(HERE, '..', 'chrome-ext')

// Two ORIGINS, not two tabs on one site. The whole point of a per-tab target is
// that two tabs are usually two different apps, and startSession's match
// pattern is per origin — one server could not tell either apart.
/** @param {string} title */
const page = (title) => `<!doctype html><html><head><title>${title}</title></head>
<body style="font:14px system-ui;padding:24px">
<h1>${title}</h1>
<button id="go" style="padding:10px 16px">do the thing</button>
<div id="out" style="margin-top:20px;padding:12px;background:#eee">nothing yet</div>
<script>document.getElementById('go').onclick = () => { document.getElementById('out').textContent = 'clicked ' + Date.now() }</script>
</body></html>`

/** @param {string} title */
async function serve(title) {
  const s = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page(title)) })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  return { server: s, url: `http://127.0.0.1:${/** @type {any} */ (s.address()).port}/` }
}

const fail = []
let ran = 0
/** @param {string} name @param {any} cond @param {any} [detail] */
const ok = (name, cond, detail) => {
  ran++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(54)} ${detail ?? ''}`)
  if (!cond) fail.push(name)
}

// --- the sessions the fake hub reports ---------------------------------------
// Shaped exactly like labelledSessions(): `label` is what sessionLabel settled
// on, and the picker must render that rather than re-deciding.
const SESSIONS = [
  { session_id: 'sess-alpha', agent: 'claude', cwd: '/Users/x/src/ledger', slug: 'ledger', title: 'rewrite the ledger', label: 'rewrite the ledger', agent_status: 'idle' },
  { session_id: 'sess-beta', agent: 'claude', cwd: '/Users/x/src/shop', slug: 'shop', title: '', pane_name: 'checkout', label: 'checkout', agent_status: 'running' },
  { session_id: 'sess-gamma', agent: 'codex', cwd: '/Users/x/src/api', slug: 'api', title: '', label: 'api' },
]

const a = await serve('alpha app')
const b = await serve('beta app')

const chromium = await loadChromium()
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rewalk-ext-'))
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: process.env.HEAD !== '1',
  viewport: { width: 1100, height: 760 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
})

/** The driver: an extension page, so it may call chrome.* and its messages
 * reach the worker the way the popup's do. It sits in the same window as the
 * tabs, INACTIVE, because activeTab() reads whichever tab is active in the
 * caller's window — which is how the real popup sees the page behind it. */
const driver = await ctx.newPage()
let sw = ctx.serviceWorkers()[0]
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 })
const ID = new URL(sw.url()).host
await driver.goto(`chrome-extension://${ID}/src/popup.html`)
ok('the unpacked extension loads', !!sw, ID)

// --- the fake native host -----------------------------------------------------
/** @param {any[]} sessions */
const installHost = (sessions) => sw.evaluate((sessions) => {
  const H = { sent: [], opens: 0, disconnects: 0, sessions }
  globalThis.__host = H
  chrome.runtime.connectNative = () => {
    H.opens++
    const msgL = [], disL = []
    const emit = (m) => setTimeout(() => { for (const f of msgL) f(m) }, 0)
    return {
      postMessage(m) {
        H.sent.push(m)
        // The host names the directory once a recording actually begins.
        if (m.control === 'start') emit({ recording: { dir: '/tmp/rewalk/out/session-ext' } })
        if (m.rid == null) return
        // H.fail stands in for every way the ask itself can fail: no host
        // installed, a hub that has not come up, a round trip past its timeout.
        if (m.control === 'sessions') emit(H.fail
          ? { rid: m.rid, ok: false, sessions: [], error: H.fail }
          : { rid: m.rid, ok: true, sessions: H.sessions })
        else if (m.comment) emit({ rid: m.rid, ok: true, id: 'rwc-ext', status: 'queued' })
        else emit({ rid: m.rid, ok: true })
      },
      disconnect() { H.disconnects++; for (const f of disL) f() },
      onMessage: { addListener: (f) => msgL.push(f) },
      onDisconnect: { addListener: (f) => disL.push(f) },
    }
  }
  // What the worker told each tab its target was. resolveTarget is the whole
  // of items 1 and 2 and it runs here, not in the page.
  globalThis.__seen = []
  if (!globalThis.__spied) {
    globalThis.__spied = 1
    const real = chrome.tabs.sendMessage.bind(chrome.tabs)
    chrome.tabs.sendMessage = (tabId, msg, opts) => {
      globalThis.__seen.push({ tabId, rewalk: msg?.rewalk, target: msg?.target })
      return real(tabId, msg, opts)
    }
  }
}, sessions)

const host = () => sw.evaluate(() => ({ ...globalThis.__host, sent: globalThis.__host.sent.map((m) => ({ ...m })) }))
const seen = () => sw.evaluate(() => globalThis.__seen)
const setSessions = (list) => sw.evaluate((l) => { globalThis.__host.sessions = l }, list)
const failSessions = (why) => sw.evaluate((w) => { globalThis.__host.fail = w }, why ?? null)
// Defensive: without "storage" in the manifest chrome.storage is simply not
// there, and that must read as a failed check rather than a stack trace out of
// the harness itself.
const stored = () => sw.evaluate(() => (chrome.storage?.session ? chrome.storage.session.get(null) : { MISSING: 'no storage permission' }))
const registered = () => sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())

await installHost(SESSIONS)

// --- talking to the worker the way the popup does -----------------------------
/** @param {string} url */
const tabIdFor = (url) => sw.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}*` }))[0]?.id ?? null, url)

/** Make a tab active, then send. Both halves from the driver page, so
 * activeTab() resolves in the same window the tabs live in. */
const asPopup = (tabId, msg) => driver.evaluate(async ({ tabId, msg }) => {
  await chrome.tabs.update(tabId, { active: true })
  return new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(chrome.runtime.lastError ? null : r)))
}, { tabId, msg })

/** The panel's own account of itself, asked from inside the extension's world. */
const probe = (tabId) => sw.evaluate(async (tabId) => {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: 'ISOLATED',
    func: () => (window.__rewalkAnnotate ? window.__rewalkAnnotate.probe() : null),
  })
  return r?.result ?? null
}, tabId)

/** Pick a session the way a person does: the real <select>, a real change. */
const choose = (tabId, sessionId) => sw.evaluate(async ({ tabId, sessionId }) => {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: 'ISOLATED',
    func: (id) => {
      const root = window.__rewalkAnnotate?.root?.()
      const sel = root && root.querySelector('select')
      if (!sel) return false
      sel.value = id
      sel.dispatchEvent(new Event('change'))
      return sel.value === id
    },
    args: [sessionId],
  })
  return r?.result ?? false
}, { tabId, sessionId })

/** Send a comment as the overlay would, from the tab's own world. */
const sendComment = (tabId, payload) => sw.evaluate(async ({ tabId, payload }) => {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: 'ISOLATED',
    func: (p) => new Promise((res) => chrome.runtime.sendMessage({ rewalk: 'comment', payload: p }, res)),
    args: [payload],
  })
  return r?.result ?? null
}, { tabId, payload })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Put the tab back where the later phases expect it. */
const rememberTargetBack = () => sw.evaluate(async (tabId) =>
  chrome.storage.session.set({ [`target:${tabId}`]: 'sess-alpha' }), idA)

// annotate-active TOGGLES, so a check that assumed the wrong parity silently
// inverted every phase after it. Ask first; only toggle when it would move.
const isOpen = async (tabId) => (await probe(tabId))?.open === true

/** The session list arrives after the panel does, so wait for the fill-in. */
const openPanel = async (tabId) => {
  if (!(await isOpen(tabId))) await asPopup(tabId, { rewalk: 'annotate-active' })
  for (let i = 0; i < 40; i++) {
    const p = await probe(tabId)
    // Settled means EITHER a real list arrived or the worker said why one did
    // not. Waiting only for the list would sit here for the whole timeout on
    // exactly the failure this checks.
    if (p?.open && (p.listError || (p.options.length && p.options[0].value))) return p
    await sleep(100)
  }
  return probe(tabId)
}
const closePanel = async (tabId) => { if (await isOpen(tabId)) await asPopup(tabId, { rewalk: 'annotate-active' }) }

// =============================================================================
console.log('\n--- the picker: what a session is called ---')
const tabA = await ctx.newPage()
await tabA.goto(a.url, { waitUntil: 'load' })
const idA = await tabIdFor(a.url)

let p = await openPanel(idA)
ok('the overlay opens on a real page', p?.open === true, `${p?.options?.length ?? 0} options`)
ok('the picker renders the hub\'s label', p?.options?.[0]?.text?.startsWith('rewrite the ledger'),
  JSON.stringify(p?.options?.map((o) => o.text)))
ok('a named pane beats the directory', p?.options?.[1]?.text?.startsWith('checkout'), p?.options?.[1]?.text)

console.log('\n--- 2. the session is auto-selected ---')
ok('a fresh tab defaults to sessions[0]', p?.session === 'sess-alpha', p?.session)
ok('and that option is the selected one', p?.options?.find((o) => o.selected)?.value === 'sess-alpha')

console.log('\n--- 1. the choice persists per TAB ---')
ok('picking a session takes', await choose(idA, 'sess-gamma'))
await sleep(200)
let store = await stored()
ok('the worker remembers it for this tab', store[`target:${idA}`] === 'sess-gamma', JSON.stringify(store))

await closePanel(idA)
await tabA.reload({ waitUntil: 'load' })
p = await openPanel(idA)
ok('it survives closing the overlay and reloading', p?.session === 'sess-gamma', p?.session)

const tabB = await ctx.newPage()
await tabB.goto(b.url, { waitUntil: 'load' })
const idB = await tabIdFor(b.url)
const pB = await openPanel(idB)
ok('a second tab does NOT inherit it', pB?.session === 'sess-alpha', pB?.session)
ok('picking there leaves the first tab alone', await choose(idB, 'sess-beta') && (await stored())[`target:${idA}`] === 'sess-gamma')
await closePanel(idB)

console.log('\n--- a remembered session that has died ---')
await setSessions(SESSIONS.filter((s) => s.session_id !== 'sess-gamma'))
await closePanel(idA)
p = await openPanel(idA)
ok('a dead target falls through to sessions[0]', p?.session === 'sess-alpha', p?.session)
store = await stored()
ok('and the fallthrough is written back', store[`target:${idA}`] === 'sess-alpha', store[`target:${idA}`])
ok('no dead session is left selected', !p?.options?.some((o) => o.selected && o.value === 'sess-gamma'))

console.log('\n--- the hub going quiet is not the same as the session dying ---')
// askNative resolves null for "not installed", "not running" and "too slow"
// alike, and all three reach resolveTarget as []. Forgetting on that would let
// one hub restart wipe what every open tab was pointed at.
await choose(idA, 'sess-beta')
await sleep(200)
await closePanel(idA)
await setSessions([])
await openPanel(idA)
store = await stored()
ok('an empty answer does not forget the choice', store[`target:${idA}`] === 'sess-beta', store[`target:${idA}`])
await setSessions(SESSIONS.filter((s) => s.session_id !== 'sess-gamma'))
await closePanel(idA)
p = await openPanel(idA)
ok('and the choice comes back when the hub does', p?.session === 'sess-beta', p?.session)
await choose(idA, 'sess-alpha')
await sleep(200)
await closePanel(idA)

console.log('\n--- "I could not ask" is not "nobody is running" ---')
await closePanel(idA)
await failSessions('the rewalk hub did not answer — no session list is available')
p = await openPanel(idA)
ok('a failed ask reaches the panel', p?.listError === 'the rewalk hub did not answer — no session list is available', p?.listError)
ok('and the picker says it, not "none running"', p?.options?.[0]?.text === p?.listError, p?.options?.[0]?.text)

await closePanel(idA)
await failSessions(null)
await setSessions([])
p = await openPanel(idA)
ok('genuinely zero sessions still reads that way', p?.options?.[0]?.text === 'no agent session is running', p?.options?.[0]?.text)
ok('and that is not dressed up as an error', !p?.listError, p?.listError)
await closePanel(idA)
await setSessions(SESSIONS.filter((s) => s.session_id !== 'sess-gamma'))
await openPanel(idA)

console.log('\n--- the comment carries it ---')
const res = await sendComment(idA, {
  text: 'the total is wrong', nodes: [], page: { url: a.url, title: 'alpha app' }, target: 'sess-alpha',
})
ok('the comment is accepted', res?.ok === true, `${res?.id} ${res?.status}`)
const envelope = (await host()).sent.filter((m) => m.comment).pop()
ok('the envelope names the chosen session', envelope?.comment?.target === 'sess-alpha', envelope?.comment?.target)
ok('the envelope carries the text', envelope?.comment?.text === 'the total is wrong')
await closePanel(idA)

console.log('\n--- a closed tab takes its choice with it ---')
await tabB.close()
await sleep(400)
store = await stored()
ok('the closed tab\'s key is pruned', store[`target:${idB}`] === undefined, JSON.stringify(store))
ok('the surviving tab keeps its own', store[`target:${idA}`] === 'sess-alpha')

console.log('\n--- recording: popup -> record -> HUD -> marks -> stop ---')
const before = (await host()).opens
const started = await asPopup(idA, { rewalk: 'start', voice: false })
ok('start reports ok', started?.ok === true, JSON.stringify(started))
let regs = await registered()
ok('three content scripts are registered', regs.length === 3, regs.map((r) => r.id).join(' '))
ok('none of them persists across sessions', regs.every((r) => r.persistAcrossSessions === false))
ok('the host was told to start', (await host()).sent.some((m) => m.control === 'start'))

// startSession reloads the tab so document_start injection catches the load.
// Nothing is drawn until Tab asks for it — that is asserted on its own below;
// here it is just the gesture that makes the HUD available to look at.
await tabA.waitForLoadState('load')
await sleep(700)
await tabA.keyboard.press('Tab')
await tabA.waitForSelector('#rewalk-hud', { timeout: 15_000 }).catch(() => {})
ok('the HUD is in the page once armed', await tabA.locator('#rewalk-hud').count() === 1)

await driver.goto(`chrome-extension://${ID}/src/popup.html`)
await sleep(300)
const popupText = await driver.textContent('body')
ok('the popup says a recording is running', /recording — DOM only/.test(popupText ?? ''), JSON.stringify((popupText ?? '').slice(0, 60)))

await tabA.click('#go')
await sleep(1400)
ok('marks reach the host', (await host()).sent.some((m) => m.batch != null),
  `${(await host()).sent.filter((m) => m.batch != null).length} batch(es)`)

await asPopup(idA, { rewalk: 'stop' })
await sleep(300)
regs = await registered()
ok('stop unregisters everything', regs.length === 0, regs.map((r) => r.id).join(' '))
ok('stop drops the native port', (await host()).disconnects >= 1)
ok('the badge is cleared', (await sw.evaluate(() => chrome.action.getBadgeText({}))) === '')

console.log('\n--- a recording puts NOTHING on the page until you ask ---')
await asPopup(idA, { rewalk: 'start', voice: false })
// The reload document_start-injects everything; give it the same beat the HUD
// assertion above waits for, then assert the page is still untouched.
await tabA.waitForLoadState('load')
await sleep(1200)
ok('no HUD before any key', await tabA.locator('#rewalk-hud').count() === 0)
const spot = { x: 400, y: 300 }
await tabA.mouse.move(spot.x, spot.y)
await sleep(300)
ok('no lens host before any key', await tabA.locator('#rewalk-lens').count() === 0)
p = await sw.evaluate(async (tabId) => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
    func: () => ({ hl: window.__rewalkHl ? window.__rewalkHl.probe() : null, armed: window.__rewalkFrames?.isArmed() }) })
  return r?.result
}, idA)
ok('the lens exists but is closed', p?.hl?.open === false && p?.armed === false, JSON.stringify(p))

// Quiet is not "off". The recording runs the whole time; it just is not drawing
// anything, and an interaction made now still has to land in the session.
const batches = async () => (await host()).sent.filter((m) => m.batch != null).length
const quietBatches = await batches()
await tabA.click('#go')
await sleep(1200)
ok('a click before any key is still recorded', await batches() > quietBatches,
  `${quietBatches} -> ${await batches()} batch(es)`)
ok('and it drew nothing to do it', await tabA.locator('#rewalk-hud').count() === 0)

// ⌥ is an ask, and the most direct one there is. Holding it must ring what is
// ALREADY under the cursor: the mouse has not moved, so a lens that learns its
// target only from pointermove comes up empty at the exact moment somebody
// reached for it. That regression shipped once; this is why.
const goBox = await tabA.locator('#go').boundingBox()
await tabA.mouse.move(goBox.x + goBox.width / 2, goBox.y + goBox.height / 2)
await sleep(250)
ok('still nothing, just hovering', await tabA.locator('#rewalk-hud').count() === 0)
await tabA.keyboard.down('Alt')
await sleep(500)
const byAlt = await sw.evaluate(async (tabId) => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
    func: () => ({ hl: window.__rewalkHl ? window.__rewalkHl.probe() : null, armed: window.__rewalkFrames?.isArmed() }) })
  return r?.result
}, idA)
await tabA.keyboard.up('Alt')
ok('⌥ alone arms', byAlt?.armed === true, JSON.stringify(byAlt?.armed))
ok('⌥ rings what is already under the pointer', byAlt?.hl?.target === '#go', byAlt?.hl?.target)
ok('⌥ brings the HUD too', await tabA.locator('#rewalk-hud').count() === 1)
ok('and the lens host is up', await tabA.locator('#rewalk-lens').count() === 1)

// Tab is the other way in, and must still reach the page: a recording in which
// focus never moves is a recording of a different program.
const focused = () => tabA.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || '')
const focusBefore = await focused()
await tabA.keyboard.press('Tab')
await sleep(400)
const focusAfter = await focused()
ok('Tab still reached the page', focusAfter !== focusBefore, `focus ${focusBefore} -> ${focusAfter}`)

console.log('\n--- the HUD says where the recording is going ---')
const hudPick = () => tabA.evaluate(() => {
  const h = document.getElementById('rewalk-hud')
  const b = h && h.querySelector('button')
  return { text: b?.textContent ?? null, rows: [...(h?.querySelectorAll('div') ?? [])].map((d) => d.textContent).filter(Boolean) }
})
for (let i = 0; i < 40 && !(await hudPick()).text?.includes('→'); i++) await sleep(100)
let hp = await hudPick()
ok('the HUD carries the tab\'s session', hp.text?.includes('rewrite the ledger'), JSON.stringify(hp.text))
ok('the host was told where it goes', (await host()).sent.some((m) => m.control === 'target' && m.target === 'sess-alpha'),
  JSON.stringify((await host()).sent.filter((m) => m.control === 'target')))
// Change it in the HUD, the way a person does.
ok('clicking a row picks it', await tabA.evaluate(() => {
  const h = document.getElementById('rewalk-hud')
  h.querySelector('button').click()
  // The innermost div: the menu container's textContent contains every row's,
  // so a plain find() matches the container and clicks nothing.
  const row = [...h.querySelectorAll('div')]
    .filter((d) => !d.querySelector('div'))
    .find((d) => (d.textContent || '').includes('checkout'))
  if (!row) return false
  row.click()
  return true
}))
await sleep(500)
hp = await hudPick()
ok('picking in the HUD changes it', hp.text?.includes('checkout'), JSON.stringify(hp.text))
ok('the worker remembered the HUD\'s pick', (await stored())[`target:${idA}`] === 'sess-beta', (await stored())[`target:${idA}`])
ok('and the host heard it too', (await host()).sent.some((m) => m.control === 'target' && m.target === 'sess-beta'))
await asPopup(idA, { rewalk: 'stop' })
await sleep(400)
await rememberTargetBack()

console.log('\n--- point at things, then write it up and SEND ---')
// The whole gesture, in the order a person does it: record, ⌥-click the things
// that are wrong, then open the overlay, pick the ones the comment is about,
// type, and press send. Two lenses are alive in one page here — the recorder's
// in MAIN and the comment overlay's in ISOLATED — plus the HUD.
await asPopup(idA, { rewalk: 'start', voice: false })
await tabA.waitForLoadState('load')
await sleep(900)
const btn = await tabA.locator('#go').boundingBox()
const overGo = () => tabA.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2)

// ⌥-click: a point in the recording, and the gesture that arms the lens.
await overGo()
const beforePoint = await batches()
await tabA.keyboard.down('Alt')
await tabA.mouse.click(btn.x + btn.width / 2, btn.y + btn.height / 2)
await tabA.keyboard.up('Alt')
await sleep(1300)
ok('⌥-click records a point', await batches() > beforePoint, `${beforePoint} -> ${await batches()}`)
ok('and the HUD is up now', await tabA.locator('#rewalk-hud').count() === 1)

p = await openPanel(idA)
ok('the send overlay opens over the recording', p?.open === true, `${p?.options?.length ?? 0} options`)
await overGo()
await sleep(300)
p = await probe(idA)
ok('the ring follows the pointer, no ⌥ needed', p?.target === '#go', p?.target)
await tabA.mouse.click(btn.x + btn.width / 2, btn.y + btn.height / 2)
await sleep(400)
p = await probe(idA)
ok('a plain click picks the element', p?.picked === 1, `picked ${p?.picked}`)

// The real button, in the real panel — not the message behind it. Send is
// disabled until there is text, which is the thing most likely to be silently
// wrong after a change to how the panel repaints.
// One static function with an op, not a closure: MV3's CSP forbids eval and
// `new Function`, so a helper that stringifies an arbitrary callback and
// rebuilds it inside the page returns null for every call and every assertion
// under it fails for a reason that has nothing to do with the panel.
const inPanel = (tabId, op, arg) => sw.evaluate(async ({ tabId, op, arg }) => {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: 'ISOLATED',
    func: (op, arg) => {
      const root = window.__rewalkAnnotate?.root?.()
      if (!root) return null
      const send = root.querySelector('button.send')
      const ta = root.querySelector('textarea')
      if (op === 'sendDisabled') return !!(send && send.disabled)
      if (op === 'type') { if (!ta) return false; ta.value = arg; ta.dispatchEvent(new Event('input')); return true }
      if (op === 'click') { if (!send || send.disabled) return false; send.click(); return true }
      if (op === 'status') return root.querySelector('.status')?.textContent ?? ''
      return null
    },
    args: [op, arg ?? null],
  })
  return r?.result
}, { tabId, op, arg })

ok('send is disabled with no text', await inPanel(idA, 'sendDisabled') === true)
await inPanel(idA, 'type', 'this button does nothing when the filter list is empty')
ok('typing enables send', await inPanel(idA, 'sendDisabled') === false)
ok('the send button clicks', await inPanel(idA, 'click') === true)
let status = ''
for (let i = 0; i < 40; i++) {
  status = await inPanel(idA, 'status')
  if (status && !status.includes('sending')) break
  await sleep(100)
}
ok('the panel reports it queued', /queued|held/.test(status), JSON.stringify(status))
const recEnv = (await host()).sent.filter((m) => m.comment).pop()
ok('the envelope carries the picked node', recEnv?.comment?.nodes?.[0]?.s === '#go',
  JSON.stringify(recEnv?.comment?.nodes?.map((n) => n.s)))
ok('and the text that was typed', recEnv?.comment?.text?.startsWith('this button does nothing'),
  JSON.stringify(recEnv?.comment?.text))
ok('it names the recording it belongs to', recEnv?.comment?.session?.dir === '/tmp/rewalk/out/session-ext',
  JSON.stringify(recEnv?.comment?.session))
await sleep(600)
ok('sending finished the recording', (await registered()).length === 0)


console.log('\n--- 4. starting kills what came before ---')
const tabC = await ctx.newPage()
await tabC.goto(b.url, { waitUntil: 'load' })
const idC = await tabIdFor(b.url)
await asPopup(idA, { rewalk: 'start', voice: false })
await tabA.waitForSelector('#rewalk-hud', { timeout: 15_000 }).catch(() => {})
const mid = await host()
await asPopup(idC, { rewalk: 'start', voice: false })
await tabC.waitForSelector('#rewalk-hud', { timeout: 15_000 }).catch(() => {})
const after = await host()
ok('the previous recording is torn down first', after.disconnects === mid.disconnects + 1,
  `disconnects ${mid.disconnects} -> ${after.disconnects}`)
ok('and a fresh host port is opened', after.opens === mid.opens + 1, `opens ${mid.opens} -> ${after.opens}`)
regs = await registered()
const patterns = [...new Set(regs.flatMap((r) => r.matches))]
ok('only the new tab is instrumented', patterns.length === 1 && patterns[0].includes(new URL(b.url).port),
  patterns.join(' '))
ok('the old tab lost its HUD', await tabA.locator('#rewalk-hud').count() === 0)
await asPopup(idC, { rewalk: 'stop' })

console.log(`\nall ${ran - fail.length}/${ran} extension checks passed${fail.length ? `\nFAILED: ${fail.join(', ')}` : ''}`)
await ctx.close()
a.server.close(); b.server.close()
fs.rmSync(profile, { recursive: true, force: true })
process.exit(fail.length ? 1 : 0)

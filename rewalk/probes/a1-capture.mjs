// Probe (A1, throwaway): the watch route's DOM capture + wall-stamped
// console.ndjson and network.ndjson, driving a scripted session against the
// seeded-bugs ledger worktree. No human was available this sitting, so the
// utterances are constructed at act time (the plan's teleprompted fallback):
// the complaint text and timing are ground truth by construction, and the
// voice pipeline is not the variable this ablation tests. The session dir
// carries synthetic:true so nobody mistakes it for a live take.
//
//   node probes/a1-capture.mjs http://localhost:3101 out/a1-session
import fs from 'node:fs'
import path from 'node:path'
import { loadChromium } from '../lib/engine.mjs'
import { bootScript, Sink } from '../lib/record.mjs'
const chromium = await loadChromium()

const [URL_, OUT] = process.argv.slice(2)
fs.rmSync(OUT, { recursive: true, force: true })
const sink = new Sink(OUT)
const consoleF = fs.createWriteStream(path.join(OUT, 'console.ndjson'))
const networkF = fs.createWriteStream(path.join(OUT, 'network.ndjson'))

const browser = await chromium.launch({ headless: false, args: ['--window-size=1360,900'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await ctx.exposeBinding('__rewalkEmit', (_s, batch) => sink.push(batch))
await ctx.addInitScript(bootScript({ mask: true, beacon: false, hud: false }))
const page = await ctx.newPage()
page.setDefaultTimeout(45000)
page.setDefaultNavigationTimeout(60000)

// -- console + network, wall-stamped ------------------------------------------
page.on('console', (m) => {
  const type = m.type()
  if (type === 'debug' || type === 'log') return          // keep the signal: warnings and errors
  consoleF.write(JSON.stringify({ wall: Date.now(), level: type, text: m.text().slice(0, 500) }) + '\n')
})
page.on('pageerror', (e) => {
  consoleF.write(JSON.stringify({ wall: Date.now(), level: 'pageerror',
    text: String(e.message).slice(0, 300), stack: String(e.stack ?? '').split('\n').slice(0, 4).join('\n') }) + '\n')
})
const reqStart = new Map()
page.on('request', (r) => reqStart.set(r, Date.now()))
page.on('requestfailed', (r) => {
  if (skipUrl(r.url())) return
  networkF.write(JSON.stringify({ wall: reqStart.get(r) ?? Date.now(), wallEnd: Date.now(),
    method: r.method(), url: short(r.url()), failed: r.failure()?.errorText ?? 'failed' }) + '\n')
})
page.on('response', async (res) => {
  const r = res.request()
  if (skipUrl(r.url())) return
  const start = reqStart.get(r) ?? Date.now()
  networkF.write(JSON.stringify({ wall: start, wallEnd: Date.now(), ms: Date.now() - start,
    method: r.method(), url: short(r.url()), status: res.status(), type: r.resourceType() }) + '\n')
})
const skipUrl = (u) => /_next\/static|_next\/image|__nextjs|webpack|favicon|\.woff|\.css|\.map($|\?)|hot-update/.test(u)
const short = (u) => u.replace(URL_, '')

// -- the session ---------------------------------------------------------------
const t0 = Date.now()
const utterances = []
const say = (text) => {
  const wall = Date.now()
  const dur = Math.max(1200, text.split(/\s+/).length * 330)
  utterances.push({ text, from: wall - t0, to: wall - t0 + dur, wall })
  console.log(`  [say] ${text}`)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

await page.goto(URL_ + '/login')
await page.fill('input[name=email]', 'ivor@ledger.local')
await page.fill('input[name=password]', 'ledger')
await page.click('form:has(input[name=password]) button[type=submit]')
await page.waitForURL((u) => !u.pathname.includes('login'))
sink.meta({ url: URL_, browserReadyWall: t0, synthetic: true })
await page.goto(URL_ + '/transactions')
await page.waitForLoadState('networkidle')
await pause(1500)

// bug A: intermittent 500 on save
await page.click('tbody tr[data-href] a')
await page.waitForSelector('aside.fixed')
await pause(900)
say('I will edit this transaction here and save it.')
await pause(1400)
try { await page.fill('aside.fixed textarea[name=notes]', 'lunch with the client') } catch {}
try { await page.fill('aside.fixed input[name=notes]', 'lunch with the client') } catch {}
await page.click('aside.fixed button.bg-indigo-700', { force: true })
await pause(1600)
say('when I save this it just blows up, this is really flaky.')
await pause(1400)
await page.click('text=Try again')
await page.waitForSelector('aside.fixed', { timeout: 8000 }).catch(() => {})
await pause(800)
await page.click('aside.fixed button.bg-indigo-700', { force: true })
await pause(1600)
say('and now the exact same save worked fine, so saving is flaky.')
await pause(1400)

// bug B: select-all dead from an unhandled rejection
await page.waitForSelector('input[data-select-all]')
await page.click('input[data-select-all]')
await pause(900)
await page.click('input[data-select-all]')
await pause(1000)
say('select all does nothing, none of the rows get selected.')
await pause(1400)

// bug C: 3s export with no pending UI (close the drawer first so the link is clickable)
await page.goto(URL_ + '/transactions')
await page.waitForLoadState('networkidle')
await pause(800)
const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
await page.click('a[href^="/api/export"]')
await pause(2200)
say('this export is just hanging, no feedback at all.')
await pause(1800)
await (await dl)?.cancel?.()
await pause(1200)

// -- finalize ------------------------------------------------------------------
try { await page.evaluate(() => window.__rrFlush?.()) } catch {}
await pause(400)
await browser.close()
consoleF.end(); networkF.end()

// one-second silent wav so the loaders have a clock probe; utterances carry
// their own wall stamps, so precision does not matter
const rate = 16000, n = rate
const data = Buffer.alloc(n * 2)
const h = Buffer.alloc(44)
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
h.write('data', 36); h.writeUInt32LE(data.length, 40)
fs.writeFileSync(path.join(OUT, 'audio.1.wav'), Buffer.concat([h, data]))
fs.writeFileSync(path.join(OUT, 'utterances.ndjson'), utterances.map((u) => JSON.stringify(u)).join('\n') + '\n')
sink.meta({ url: URL_, browserReadyWall: t0, endedWall: Date.now(), events: sink.n, synthetic: true,
  note: 'scripted session, constructed utterances — no live human this take',
  audioClocks: [{ ok: true, file: 'audio.1.wav', startWall: t0, driftPpm: 0, residualMs: 0, n: 2 }] })
sink.close()
console.log(`done: ${sink.n} rrweb events, ${utterances.length} utterances -> ${OUT}`)

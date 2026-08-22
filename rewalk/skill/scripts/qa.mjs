// CSV-driven web QA. Produces a portable rrweb replay, Playwright traces,
// a report, and a results CSV that feeds a fix loop.
// Config: qa.config.json (see qa.config.example.json). Env overrides: BASE LANES TIMEOUT VIDEO CSV
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
// Deps live beside the skill, not in the user's project. On a fresh clone they
// are absent, so fail with an instruction instead of ERR_MODULE_NOT_FOUND.
const SKILL_ROOT = path.join(HERE, '..')
let chromium
try { ({ chromium } = await import('playwright')) } catch {
  console.error(`\nweb-qa: dependencies are not installed.\n  cd ${SKILL_ROOT.replace(process.env.HOME, '~')} && npm install\n`)
  process.exit(3)
}
for (const dep of ['rrweb/dist/rrweb.umd.min.cjs', 'rrweb-player/dist/rrweb-player.umd.cjs']) {
  if (!fs.existsSync(path.join(SKILL_ROOT, 'node_modules', dep))) {
    console.error(`\nweb-qa: missing ${dep}.\n  cd ${SKILL_ROOT.replace(process.env.HOME, '~')} && npm install\n`)
    process.exit(3)
  }
}
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG ?? 'qa.config.json', 'utf8'))
const BASE    = process.env.BASE ?? cfg.base
const CSV     = process.env.CSV ?? cfg.cases ?? 'cases.csv'
const OUT     = cfg.out ?? 'out'
const TIMEOUT = Number(process.env.TIMEOUT ?? cfg.timeout ?? 4000)
const LANES   = Number(process.env.LANES ?? cfg.lanes ?? 6)
const VIDEO   = process.env.VIDEO ? true : !!cfg.video
const VW = cfg.viewport?.width ?? 1280, VH = cfg.viewport?.height ?? 800
const IGNORE = (cfg.ignore ?? []).map(p => new RegExp(p))

const parseCsv = t => {
  const rows = [], re = /("([^"]*(?:""[^"]*)*)"|[^,\n\r]*)(,|\r?\n|$)/g
  let row = [], m
  while ((m = re.exec(t)) && m[0]) {
    row.push(m[2] !== undefined ? m[2].replace(/""/g, '"') : m[1])
    if (m[3] !== ',') { rows.push(row); row = [] }
    if (m[3] === '') break
  }
  const head = rows.shift()
  return rows.filter(r => r.length > 1 && r[0]).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])))
}

// Assertions RETRY to a deadline. A one-shot read races async redirects
// (server actions, client routers) and reports bugs that are not there.
const until = async (fn, ms = TIMEOUT) => {
  const deadline = Date.now() + ms
  let actual = '(never evaluated)'
  for (;;) {
    try { const r = await fn(); actual = r.actual; if (r.ok) return { ok: true, actual } }
    catch (e) { actual = e.message.split('\n')[0] }
    if (Date.now() > deadline) return { ok: false, actual }
    await new Promise(r => setTimeout(r, 120))
  }
}

// ---- phase 0: is the thing on that port actually the app under test? -------
async function groundTruth(browser) {
  const g = cfg.groundTruth
  if (!g) return
  const p = await (await browser.newContext()).newPage()
  const res = await p.goto(BASE + g.route, { waitUntil: 'domcontentloaded' }).catch(() => null)
  const body = res ? await p.locator('body').innerText().catch(() => '') : ''
  const ok = res && res.status() < 400 && (!g.contains || body.includes(g.contains))
  await p.context().close()
  if (!ok) {
    console.error(`\nGROUND TRUTH FAILED: ${BASE}${g.route} -> ${res ? res.status() : 'no response'}`)
    if (g.contains) console.error(`  expected body to contain ${JSON.stringify(g.contains)}`)
    console.error(`  Another process may own this port. Check: lsof -ti:${new URL(BASE).port} | xargs ps -p\n`)
    process.exit(2)
  }
}

// one executor, used for both the auth preamble and every CSV row
async function exec(page, r, glide, ms = TIMEOUT) {
  const el = r.target ? page.locator(r.target) : null      // strict: >1 match is an error
  switch (r.action) {
    case 'goto':
      await page.goto(BASE + r.target, { waitUntil: 'domcontentloaded' })
      return page.url().replace(BASE, '')
    case 'fill': {
      if (glide) await glide(el)
      await el.click({ timeout: ms })
      const kind = await el.getAttribute('type')
      if (['date', 'number', 'time', 'datetime-local', 'month', 'color', 'range'].includes(kind)) {
        await el.fill(r.value)                             // segmented inputs cannot be typed blind
      } else {
        await el.fill(''); await el.pressSequentially(r.value, { delay: 20 })
      }
      let v = await el.inputValue()
      if (v !== r.value) {                                  // typing dropped it: retry, then fail loudly
        await el.fill(r.value); v = await el.inputValue()
        if (v !== r.value) throw new Error(`value did not stick: wanted ${JSON.stringify(r.value)}, field holds ${JSON.stringify(v)}`)
      }
      return v
    }
    case 'select': {
      if (glide) await glide(el)
      await el.selectOption(r.value, { timeout: ms })
      const v = await el.inputValue()
      if (v !== r.value) throw new Error(`select holds ${JSON.stringify(v)}, wanted ${JSON.stringify(r.value)}`)
      return v
    }
    case 'click':  if (glide) await glide(el); await el.click({ timeout: ms }); return 'clicked'
    case 'press':  if (glide) await glide(el); await el.press(r.value, { timeout: ms }); return `pressed ${r.value}`
    case 'hover':  if (glide) await glide(el); await el.hover({ timeout: ms }); return 'hovered'
    case 'assert_visible': await el.waitFor({ state: 'visible', timeout: ms }); return 'visible'
    case 'assert_hidden': {
      const res = await until(async () => ({ ok: !(await el.isVisible().catch(() => false)), actual: 'still visible' }), ms)
      if (!res.ok) throw new Error(res.actual)
      return 'hidden'
    }
    case 'assert_url': {
      // '!x' must NOT contain, '=x' exact. Plain substring matched /a/new for /a.
      const neg = r.expect.startsWith('!'), exact = r.expect.startsWith('=')
      const needle = neg || exact ? r.expect.slice(1) : r.expect
      const res = await until(async () => {
        const u = page.url().replace(BASE, '')
        const hit = exact ? u === needle : u.includes(needle)
        return { ok: neg ? !hit : hit, actual: u }
      }, ms)
      if (!res.ok) throw Object.assign(new Error(`url is ${res.actual}`), { actual: res.actual })
      return res.actual
    }
    case 'assert_text': {
      const res = await until(async () => {
        const txt = await page.locator(r.target || 'body').innerText({ timeout: 1000 })
        const i = txt.indexOf(r.expect)
        return { ok: i >= 0, actual: i >= 0
          ? txt.slice(Math.max(0, i - 30), i + r.expect.length + 30).replace(/\s+/g, ' ')
          : txt.replace(/\s+/g, ' ').slice(0, 160) + ' …' }
      }, ms)
      if (!res.ok) throw Object.assign(new Error('text not found'), { actual: res.actual })
      return res.actual
    }
    case 'assert_count': {
      const [, op = '=', want] = r.expect.match(/^(>=|<=|>|<|=)?\s*(\d+)$/) ?? []
      const w = Number(want)
      const res = await until(async () => {
        const n = await page.locator(r.target).count()
        return { ok: ({ '>': n > w, '<': n < w, '>=': n >= w, '<=': n <= w, '=': n === w })[op], actual: String(n) }
      }, ms)
      if (!res.ok) throw Object.assign(new Error(`count is ${res.actual}`), { actual: res.actual })
      return res.actual
    }
    default: throw new Error(`unknown action: ${r.action}`)
  }
}

const RRWEB  = fs.readFileSync(path.join(HERE, '../node_modules/rrweb/dist/rrweb.umd.min.cjs'), 'utf8').toString()
const RECORD = fs.readFileSync(path.join(HERE, 'rrweb-record.js'), 'utf8')
  .replaceAll('__MASK__', JSON.stringify(!!cfg.mask))

const rows = parseCsv(fs.readFileSync(CSV, 'utf8'))
const flows = [...new Set(rows.map(r => r.flow_id))]
const isAnon = f => (cfg.auth?.anonymousFlows ?? []).some(g => new RegExp('^' + g.replace(/\*/g, '.*') + '$').test(f))

for (const d of ['traces', 'replay', 'video']) fs.mkdirSync(`${OUT}/${d}`, { recursive: true })

const browser = await chromium.launch()
await groundTruth(browser)

let storageState
if (cfg.auth?.steps?.length) {
  const c = await browser.newContext({ viewport: { width: VW, height: VH } })
  const p = await c.newPage()
  for (const [action, target, value] of cfg.auth.steps)
    await exec(p, { action, target, value, expect: value }, null)
  storageState = await c.storageState()
  await c.close()
}

const run = { base: BASE, viewport: { w: VW, h: VH }, timeout: TIMEOUT, flows: [] }

const runFlow = async flow => {
  const anon = isAnon(flow)
  const ctx = await browser.newContext({
    viewport: { width: VW, height: VH },
    ...(VIDEO ? { recordVideo: { dir: `${OUT}/video`, size: { width: VW, height: VH } } } : {}),
    ...(anon || !storageState ? {} : { storageState }),
  })
  const rr = []
  await ctx.exposeBinding('__rrwebEmit', (_s, batch) => { rr.push(...batch) })
  await ctx.addInitScript(RRWEB + ';\n' + RECORD)          // UMD ends in `}))` with no semicolon
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true, title: flow })
  const page = await ctx.newPage()

  const net = [], logs = []
  const T0 = Date.now(), now = () => Date.now() - T0
  const keep = s => !IGNORE.some(re => re.test(s))
  page.on('console', m => m.type() === 'error' && keep(m.text()) && logs.push({ t: now(), kind: 'console', text: m.text() }))
  page.on('pageerror', e => keep(e.message) && logs.push({ t: now(), kind: 'pageerror', text: e.message }))
  page.on('requestfailed', r => keep(r.url()) && logs.push({ t: now(), kind: 'requestfailed', text: `${r.method()} ${r.url()} ${r.failure()?.errorText}` }))
  page.on('response', r => {
    net.push({ t: now(), method: r.request().method(), url: r.request().url().replace(BASE, ''), status: r.status(),
               type: r.request().resourceType(), ct: (r.headers()['content-type'] || '').split(';')[0] })
    if (r.status() >= 400 && keep(r.url())) logs.push({ t: now(), kind: 'http', text: `${r.status()} ${r.request().method()} ${r.request().url()}` })
  })

  let pos = { x: VW / 2, y: VH - 60 }
  const glide = async loc => {                              // smooth pointer path for the replay
    const b = await loc.boundingBox({ timeout: TIMEOUT }).catch(() => null)
    if (!b) return
    const to = { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 18) }
    for (let i = 1; i <= 14; i++) {
      const e = i / 14, k = e < .5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2
      await page.mouse.move(pos.x + (to.x - pos.x) * k, pos.y + (to.y - pos.y) * k)
      await page.waitForTimeout(10)
    }
    pos = to
  }
  const mark = p => page.evaluate(x => window.__qaStep?.(x), p).catch(() => {})

  const steps = []
  for (const r of rows.filter(x => x.flow_id === flow)) {
    const t_start = now(), nBefore = logs.length
    let status = 'pass', error = '', actual = ''
    await page.evaluate(() => window.__rrFlush?.()).catch(() => {})
    await mark({ step: +r.step, phase: 'start', action: r.action, target: r.target })
    await ctx.tracing.group(`${flow}/${r.step} ${r.action} ${r.target || r.expect}`)
    const tExec = Date.now()
    try {
      if (r.action === 'goto') pos = { x: VW / 2, y: VH - 60 }
      actual = await exec(page, r, glide, Number(r.timeout) || TIMEOUT)
    } catch (e) {
      status = 'FAIL'; error = e.message.split('\n')[0]; actual = e.actual ?? actual
    } finally { await ctx.tracing.groupEnd() }

    // invariants: a step that "passed" still fails if the page complained
    const mine = logs.slice(nBefore)
    if (status === 'pass' && mine.length) { status = 'FAIL'; error = `invariant: ${mine[0].kind} ${mine[0].text}` }

    await mark({ step: +r.step, phase: 'end', action: r.action, status })
    steps.push({ ...r, status, error, expected: r.expect || r.value || '', actual,
                 t_start, t_end: now(), exec_ms: Date.now() - tExec, logs: mine })
  }

  await page.evaluate(() => window.__rrFlush?.()).catch(() => {})
  await ctx.tracing.stop({ path: `${OUT}/traces/${flow}.zip` })
  const vpath = VIDEO ? await page.video().path() : null
  await ctx.close()                                          // video only finalises on close
  if (vpath) fs.renameSync(vpath, `${OUT}/video/${flow}.webm`)
  fs.writeFileSync(`${OUT}/replay/${flow}.json`, JSON.stringify(rr))
  return { id: flow, trace: `traces/${flow}.zip`, replay: `${flow}.json`, t0Epoch: T0,
           duration: now(), steps, net, rrwebEvents: rr.length }
}

// Independent contexts, so pool them. Caveat: they share one backend, so any
// assertion depending on global state must be scoped per flow.
const queue = [...flows], done = []
await Promise.all(Array.from({ length: Math.min(LANES, queue.length) }, async () => {
  for (let f; (f = queue.shift());) done.push(await runFlow(f))
}))
run.flows = flows.map(id => done.find(f => f.id === id))
await browser.close()

fs.writeFileSync(`${OUT}/run.json`, JSON.stringify(run, null, 1))

// Calibration: headroom is per row, since a row may carry its own timeout.
// A failing assertion costs exactly its budget, so this is also the runtime lever.
const passing = run.flows.flatMap(f => f.steps).filter(s => s.status === 'pass' && s.action.startsWith('assert'))
if (passing.length) {
  const rated = passing.map(s => ({ ...s, budget: Number(s.timeout) || TIMEOUT }))
                       .map(s => ({ ...s, ratio: s.budget / Math.max(s.exec_ms, 1) }))
                       .sort((a, b) => a.ratio - b.ratio)
  const d = passing.map(s => s.exec_ms).sort((a, b) => a - b)
  const worst = rated[0]
  console.log(`\nassertion latency: median ${d[d.length >> 1]}ms  p90 ${d[Math.floor(d.length * .9)]}ms  max ${d[d.length - 1]}ms`)
  console.log(`tightest headroom: ${worst.ratio.toFixed(1)}x on ${worst.flow_id}/${worst.step} ` +
              `(${worst.action} took ${worst.exec_ms}ms, budget ${worst.budget}ms)` +
              (worst.ratio < 5 ? `\n  -> under 5x and will flake. Add a \`timeout\` column on that row, or raise TIMEOUT.` : ''))
}
await import('./report.mjs')

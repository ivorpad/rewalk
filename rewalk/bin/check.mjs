// rewalk check — walk the same ground scripted, measure, assert.
//
// Every assertion here is written against a *contract* ("the line you are
// explaining is on screen"), never against a snapshot ("the lens sits at
// x=964"). A check that encodes current behaviour passes forever and catches
// nothing, and worse, it goes red when the design improves.
//
// And an assertion nobody has watched fail is a claim, not a check. So this
// runs every assertion twice: against the broken variant, where it must go RED,
// and the fixed one, where it must go GREEN. An assertion that cannot be driven
// red is reported as UNFALSIFIABLE and is worth exactly nothing.
//
//   node bin/check.mjs                      # falsification run, both variants
//   node bin/check.mjs <url>                # measure one page

import { loadChromium } from '../lib/engine.mjs'
const chromium = await loadChromium()
import { bootScript } from '../lib/record.mjs'
import { ensureFixtureServer } from '../lib/serve.mjs'

const server = await ensureFixtureServer()
const BASE = process.env.LAB ?? server.url('lab.html')
const STEPS = 5

// A measurement pass: click through, and after each step record the geometry
// the assertions are written over.
async function walk(url) {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const motion = []
  await ctx.exposeBinding('__rewalkEmit', (_s, batch) => {
    for (const e of batch)
      if (e.type === 5 && e.data.tag === 'rewalk-motion-window') motion.push(e.data.payload)
  })
  await ctx.addInitScript(bootScript({ mask: false }))
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(900)

  const PROBE = `(() => {
    const code = document.getElementById('code');
    const lens = document.getElementById('lens');
    const hot  = code.querySelector('.ln.hot');
    const cr = code.getBoundingClientRect();
    const lr = lens.getBoundingClientRect();
    const hr = hot && hot.getBoundingClientRect();
    return {
      line: hot ? Number(hot.dataset.line) : null,
      lensX: Math.round(lr.x), lensY: Math.round(lr.y),
      lensH: Math.round(lr.height),
      scrollTop: Math.round(code.scrollTop),
      hotTop: hr ? Math.round(hr.top - cr.top) : null,
      hotBottom: hr ? Math.round(hr.bottom - cr.top) : null,
      viewH: Math.round(cr.height),
      onScreen: hr ? (hr.top >= cr.top && hr.bottom <= cr.bottom) : null,
    };
  })()`

  const seen = []
  for (let i = 0; i < STEPS; i++) {
    await page.click('#next')
    await page.waitForTimeout(1400)
    seen.push(await page.evaluate(PROBE))
  }
  // let the last motion window close and reach disk before tearing down; the
  // final interaction is exactly the one worth measuring
  await page.waitForTimeout(900)
  await page.evaluate(() => window.__rrFlush?.())
  await page.waitForTimeout(300)
  await browser.close()
  return { seen, motion }
}

// --- the contract --------------------------------------------------------
const ASSERTIONS = [
  {
    id: 'focus-visible',
    says: 'the line being explained is inside the code viewport at every step',
    run: ({ seen }) => {
      const bad = seen.filter((s) => s.onScreen === false)
      return { ok: bad.length === 0,
        detail: `${seen.length - bad.length}/${seen.length} steps on screen` +
          (bad.length ? `; off screen at lines ${bad.map((b) => b.line).join(', ')}` +
            ` (hotTop ${bad.map((b) => b.hotTop).join(', ')} vs viewport 0..${seen[0].viewH})` : '') }
    },
  },
  {
    id: 'lens-holds-still',
    says: 'the explanation card does not jump horizontally between steps',
    run: ({ seen }) => {
      let worst = 0
      for (let i = 1; i < seen.length; i++) worst = Math.max(worst, Math.abs(seen[i].lensX - seen[i - 1].lensX))
      return { ok: worst <= 24, detail: `largest single-step horizontal jump ${worst}px (budget 24px)` }
    },
  },
  {
    id: 'motion-settles',
    says: 'everything stops moving within 400ms of an interaction',
    run: ({ motion }) => {
      const worst = Math.max(0, ...motion.map((m) => m.settleMs ?? 0))
      return { ok: worst <= 400, detail: `slowest settle ${worst}ms across ${motion.length} interactions (budget 400ms)` }
    },
  },
  {
    id: 'no-interrupted-motion',
    says: 'no transition is cancelled mid-flight (that is what reads as smearing)',
    run: ({ motion }) => {
      const n = motion.reduce((s, m) => s + (m.cancels ?? 0), 0)
      return { ok: n === 0, detail: `${n} transitioncancel across ${motion.length} interactions` }
    },
  },
  {
    id: 'no-wandering',
    says: 'nothing travels much further than the distance it actually needed to move',
    run: ({ motion }) => {
      const w = motion.flatMap((m) => m.tracks ?? []).filter((t) => t.wander != null)
      const worst = Math.max(1, ...w.map((t) => t.wander))
      const who = w.find((t) => t.wander === worst)
      return { ok: worst <= 1.5,
        detail: `worst path/net ${worst}${who ? ` on ${who.s} (${who.path}px travelled, ${who.net}px net)` : ''} (budget 1.5)` }
    },
  },
]

const pad = (s, n) => String(s).padEnd(n)

if (process.argv[2]) {
  const m = await walk(process.argv[2])
  for (const a of ASSERTIONS) {
    const r = a.run(m)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(a.id, 22)} ${r.detail}`)
  }
  process.exit(ASSERTIONS.every((a) => a.run(m).ok) ? 0 : 1)
} else {
  console.log('falsification run: each assertion must go RED on the broken page and GREEN on the fixed one.\n')
  const broken = await walk(BASE)
  const fixed = await walk(BASE + '?fixed=1')
  let bad = 0
  console.log(`${pad('assertion', 22)} ${pad('broken', 8)} ${pad('fixed', 8)} verdict`)
  for (const a of ASSERTIONS) {
    const b = a.run(broken), f = a.run(fixed)
    const verdict = !b.ok && f.ok ? 'falsifiable'
      : b.ok && f.ok ? 'UNFALSIFIABLE — never seen red'
      : !f.ok ? 'BROKEN — red on the fixed page too'
      : '?'
    if (verdict !== 'falsifiable') bad++
    console.log(`${pad(a.id, 22)} ${pad(b.ok ? 'pass' : 'FAIL', 8)} ${pad(f.ok ? 'pass' : 'FAIL', 8)} ${verdict}`)
    console.log(`  ${pad('', 20)} broken: ${b.detail}`)
    console.log(`  ${pad('', 20)} fixed:  ${f.detail}`)
  }
  console.log(`\n${ASSERTIONS.length - bad}/${ASSERTIONS.length} assertions demonstrated failing for the right reason`)
  process.exit(bad ? 1 : 0)
}

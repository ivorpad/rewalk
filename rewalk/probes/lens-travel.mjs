// How far the lens travels between consecutive recorded moments.
// Walks a scene's value track and reports the card's rect each step, plus the
// placement it implies, so "the card flies around" becomes a number.

import { chromium } from '../skill/node_modules/playwright/index.mjs'

const URL_ = process.argv[2]
const STEPS = +(process.argv[3] ?? 5)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
await page.goto(URL_, { waitUntil: 'load' })
await page.waitForTimeout(3500)
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(4000)

await page.evaluate(() => {
  ;[...document.querySelectorAll('button')]
    .find((b) => b.offsetParent && b.textContent.includes('Let the model read the design system'))
    ?.click()
})
await page.waitForTimeout(2000)
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === 'Values')?.click())
await page.waitForTimeout(2500)

const PROBE = `(() => {
  const code = document.querySelector('[aria-label^="Source code"]');
  const lens = document.querySelector('[aria-label="Explanation lens"]');
  const rows = [...code.querySelectorAll('[data-line]')];
  const strong = rows.find((r) => /79,\\s*209,\\s*197/.test(r.style.background || ''));
  const cr = code.getBoundingClientRect();
  const lr = lens && lens.getBoundingClientRect();
  const sr = strong && strong.getBoundingClientRect();
  const conn = [...code.parentElement.querySelectorAll('div[aria-hidden="true"]')].find((n) => {
    const b = getComputedStyle(n).backgroundColor;
    const r = n.getBoundingClientRect();
    return b === 'rgba(139, 124, 255, 0.45)' && r.height < 6;
  });
  const kr = conn && conn.getBoundingClientRect();
  return {
    connTop: kr ? Math.round(kr.top - cr.top) : null,
    connTrans: conn ? getComputedStyle(conn).transitionDuration : null,
    strongMid: sr ? Math.round(sr.top + sr.height / 2 - cr.top) : null,
    bottom: lr ? Math.round(lr.bottom - cr.top) : null,
    counter: document.querySelector('[aria-label="Timeline position"]')?.textContent.trim(),
    line: strong ? Number(strong.dataset.line) : null,
    top: lr ? Math.round(lr.top - cr.top) : null,
    left: lr ? Math.round(lr.left - cr.left) : null,
    w: lr ? Math.round(lr.width) : null,
    h: lr ? Math.round(lr.height) : null,
    strongTop: sr ? Math.round(sr.top - cr.top) : null,
    onScreen: sr ? sr.top >= cr.top && sr.bottom <= cr.bottom : null,
    scroll: Math.round(code.scrollTop),
    vw: Math.round(cr.width),
    vh: Math.round(cr.height),
  };
})()`

const seen = [await page.evaluate(PROBE)]
for (let i = 0; i < STEPS - 1; i++) {
  await page.evaluate(() => document.querySelector('[aria-label="Next recorded moment"]')?.click())
  await page.waitForTimeout(2600)
  seen.push(await page.evaluate(PROBE))
}

const place = (s) => (s.left <= 24 && s.w > s.vw * 0.7 ? 'strip' : s.left <= 70 ? 'below/above' : 'right')
console.log('step | counter        | line | lens top,left  w x h      | placement   | travel')
let prev = null
for (const s of seen) {
  const d = prev ? `Δ ${Math.abs(s.top - prev.top)}px vert, ${Math.abs(s.left - prev.left)}px horiz` : '—'
  console.log(
    `     | ${String(s.counter).padEnd(14)} | ${String(s.line).padEnd(4)} | ${String(s.top).padStart(4)},${String(s.left).padStart(5)}  ${s.w}x${s.h}`.padEnd(66) +
      ` | bot ${String(s.bottom).padStart(4)} | ${d} | conn ${String(s.connTop).padStart(4)} vs line mid ${String(s.strongMid).padStart(4)} (${s.connTrans})`,
  )
  prev = s
}
const tops = seen.map((s) => s.top), lefts = seen.map((s) => s.left)
console.log(`\nvertical spread   ${Math.min(...tops)}..${Math.max(...tops)}  (${Math.max(...tops) - Math.min(...tops)}px)`)
console.log(`horizontal spread ${Math.min(...lefts)}..${Math.max(...lefts)}  (${Math.max(...lefts) - Math.min(...lefts)}px)`)
console.log(`placements        ${[...new Set(seen.map(place))].join(', ')}`)
console.log(`all on screen     ${seen.every((s) => s.onScreen)}`)
console.log(`console errors    ${errs.length}`)
await browser.close()

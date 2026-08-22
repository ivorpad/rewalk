import { chromium } from '../skill/node_modules/playwright/index.mjs'
const b = await chromium.launch({ headless: true })
const page = await b.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type()==='error' && errs.push(m.text()))
await page.goto(process.argv[2], { waitUntil: 'load' }); await page.waitForTimeout(2500)
await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(3000)
// walk to the tall scene, then turn values on
await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Mental model"] button')].find(x => /settle/i.test(x.textContent))?.click())
await page.waitForTimeout(1200)
await page.evaluate(() => { if (!document.querySelector('[aria-label="Timeline position"]')) [...document.querySelectorAll('button')].find(x => /Toggle recorded values/.test(x.title||''))?.click() })
await page.waitForTimeout(2000)
const P = `(() => {
  const code = document.querySelector('[aria-label^="Source code"]');
  const lens = document.querySelector('[aria-label="Explanation lens"]');
  const rows = [...code.querySelectorAll('[data-line]')];
  const strong = rows.find(r => /79,\\s*209,\\s*197/.test(r.style.background||''));
  const cr = code.getBoundingClientRect(), lr = lens&&lens.getBoundingClientRect(), sr = strong&&strong.getBoundingClientRect();
  const mid = sr && sr.top + sr.height/2;
  return { counter: document.querySelector('[aria-label="Timeline position"]')?.textContent.trim(),
    line: strong?+strong.dataset.line:null,
    onScreen: sr ? sr.top>=cr.top && sr.bottom<=cr.bottom : null,
    inside: (lr&&sr) ? mid>=lr.top && mid<=lr.bottom : null,
    top: lr?Math.round(lr.top-cr.top):null, left: lr?Math.round(lr.left-cr.left):null,
    scroll: Math.round(code.scrollTop) };
})()`
const seen = [await page.evaluate(P)]
for (let i=0;i<7;i++){ await page.evaluate(()=>document.querySelector('[aria-label="Next recorded moment"]')?.click()); await page.waitForTimeout(2400); seen.push(await page.evaluate(P)) }
let prev=null
for (const s of seen){ const d = prev?`move ${Math.abs(s.top-prev.top)}v/${Math.abs(s.left-prev.left)}h`:'—'
  console.log(`  ${String(s.counter).padEnd(12)} line ${String(s.line).padEnd(4)} onScreen ${String(s.onScreen).padEnd(5)} inCard ${String(s.inside).padEnd(5)} card ${s.top},${s.left}  scroll ${String(s.scroll).padEnd(6)} ${d}`); prev=s }
const tops=seen.map(s=>s.top), lefts=seen.map(s=>s.left)
console.log(`\n  all moments on screen: ${seen.every(s=>s.onScreen)} | all inside card: ${seen.every(s=>s.inside)}`)
console.log(`  card travel: ${Math.max(...tops)-Math.min(...tops)}px vertical, ${Math.max(...lefts)-Math.min(...lefts)}px horizontal`)
console.log(`  scroll range: ${Math.min(...seen.map(s=>s.scroll))}..${Math.max(...seen.map(s=>s.scroll))} (viewport must move for a 118-line block)`)
console.log(`  console errors: ${errs.length}`)
await b.close()

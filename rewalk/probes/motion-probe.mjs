// Is CSS motion actually invisible to a recorder? Test, don't assert.
import { chromium } from '../skill/node_modules/playwright/index.mjs'
const b = await chromium.launch({ headless: true })
const page = await b.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(process.argv[2], { waitUntil: 'load' }); await page.waitForTimeout(3000)
await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(3500)
await page.evaluate(() => [...document.querySelectorAll('button')].find(x => x.offsetParent && x.textContent.includes('Let the model read the design system'))?.click())
await page.waitForTimeout(1500)
await page.evaluate(() => [...document.querySelectorAll('button')].find(x => x.offsetParent && x.textContent.trim() === 'Values')?.click())
await page.waitForTimeout(2000)

// 1. transition lifecycle events  2. Web Animations API sampling
await page.evaluate(() => {
  window.__motion = { run: 0, start: 0, end: 0, cancel: 0, byProp: {}, cancelled: [] }
  const bump = (k, e) => {
    window.__motion[k]++
    const p = e.propertyName || '?'
    window.__motion.byProp[p] = (window.__motion.byProp[p] || 0) + 1
    if (k === 'cancel') window.__motion.cancelled.push(`${e.target.getAttribute?.('aria-label') || e.target.tagName}:${p}`)
  }
  for (const [ev, k] of [['transitionrun','run'],['transitionstart','start'],['transitionend','end'],['transitioncancel','cancel']])
    document.addEventListener(ev, (e) => bump(k, e), true)
  window.__reset = () => { window.__motion = { run:0,start:0,end:0,cancel:0,byProp:{},cancelled:[] } }
  window.__sampleAnimating = async (ms) => {
    const seen = new Set(); const t0 = performance.now(); let frames = 0, busy = 0
    return await new Promise((res) => {
      const tick = () => {
        frames++
        const anims = document.getAnimations()
        if (anims.length) { busy++; for (const a of anims) seen.add((a.effect?.target?.getAttribute?.('aria-label') || a.effect?.target?.tagName || '?') + ':' + (a.transitionProperty || a.animationName || '?')) }
        if (performance.now() - t0 < ms) requestAnimationFrame(tick)
        else res({ frames, framesAnimating: busy, motionMs: Math.round(busy / frames * (performance.now() - t0)), targets: [...seen].slice(0, 8) })
      }
      requestAnimationFrame(tick)
    })
  }
})

for (let i = 0; i < 3; i++) {
  await page.evaluate(() => { window.__reset(); document.querySelector('[aria-label="Next recorded moment"]')?.click() })
  const anim = await page.evaluate(() => window.__sampleAnimating(1500))
  const ev = await page.evaluate(() => window.__motion)
  console.log(`step ${i + 1}: transitionrun ${ev.run} start ${ev.start} end ${ev.end} cancel ${ev.cancel}`)
  console.log(`         props ${JSON.stringify(ev.byProp)}`)
  console.log(`         getAnimations: ${anim.framesAnimating}/${anim.frames} frames in motion (~${anim.motionMs}ms), targets ${JSON.stringify(anim.targets)}`)
  if (ev.cancelled.length) console.log(`         CANCELLED mid-flight: ${JSON.stringify(ev.cancelled.slice(0, 6))}`)
  await page.waitForTimeout(800)
}
await b.close()

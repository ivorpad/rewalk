// Probe (A3 stage 1, throwaway): generate one executable Playwright repro per
// locatable complaint, from the session's click marks (steps) plus ONE
// assertion synthesized from the complaint's words, top deltas and the
// clicked mark's ancestor chain. Rules are fixed here, before any run:
//   R1 dismiss:   last click matches /close|dismiss|cancel/ -> the clicked
//                 element's recorded container must hide/detach within 2s
//   R4 loading:   words or top deltas name a loading animation -> no visible
//                 .animate-pulse survives 1.5s after the last step
//   R3 feedback:  words say "feedback"/"don't see" -> the last button click
//                 must cause >=1 DOM mutation inside its recorded container
//                 within 1.5s
//   R2 dead-ctrl: words say "cannot/nothing happens" -> the last click must
//                 change the URL or cause >=3 body mutations within 1.5s
// Steps: every click from session start through the complaint window's end;
// when the window holds no click (announce-then-act), extend to the first
// click within 4s after the utterance starts. Clicks that predate the app's
// first authenticated page are replaced by a login preamble — the recording
// masks typed input, so credentials cannot come from the session (measured
// data dependence, reported in the result).
//
//   node probes/a3-repro-gen.mjs out/ledger-01 out/a3-repros http://localhost:3100
import fs from 'node:fs'
import path from 'node:path'
import { readStream, extractMarks } from '../lib/deltas.mjs'

const [DIR, OUT, BASE] = process.argv.slice(2)
const resolved = JSON.parse(fs.readFileSync(path.join(DIR, 'resolved.json'), 'utf8'))
const events = readStream(fs.readFileSync(path.join(DIR, 'events.ndjson'), 'utf8'))
const { marks } = extractMarks(events)
const clicks = marks.filter((m) => m.kind === 'click')
const metas = events.filter((e) => e.type === 4).map((e) => ({ at: e.timestamp, href: e.data.href }))
const appStart = metas.find((m) => !/login/.test(m.href))?.at ?? 0
const appPath = new URL(metas.find((m) => !/login/.test(m.href))?.href ?? BASE).pathname

const TARGETS = [
  { key: 'open-animation', re: /open here/i },
  { key: 'doesnt-close', re: /doesn't close/i },
  { key: 'save-change', re: /save this change/i },
  { key: 'feedback', re: /any sort of feedback/i },
  { key: 'cannot-open', re: /cannot open/i },
]

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
const containerOf = (mark, fallback) => {
  const chain = (mark.chain ?? []).slice(1)
  return chain.find((c) => /\[aria-label=|aside|dialog|form/.test(c)) ?? fallback
}

fs.mkdirSync(OUT, { recursive: true })
const manifest = []
for (const t of TARGETS) {
  const u = resolved.find((r) => t.re.test(r.said))
  if (!u) { console.log(`no utterance for ${t.key}`); continue }
  const [lo, hi] = u.window
  let mine = clicks.filter((c) => c.at >= lo && c.at <= hi)
  let stepEnd = hi
  if (!mine.length) {
    const next = clicks.find((c) => c.at > u.at && c.at <= u.at + 4000)
    if (next) { stepEnd = next.at; mine = [next] }
    else stepEnd = u.at            // steps are everything already done
  }
  let steps = clicks.filter((c) => c.at >= appStart && c.at <= stepEnd)

  // rule selection
  const last = steps[steps.length - 1]
  const said = u.said
  let rule = null
  if (last && /close|dismiss|cancel/i.test((last.s ?? '') + (last.text ?? ''))) rule = 'R1'
  else if (/animation|loading|skeleton/i.test(said) || (u.deltas ?? []).slice(0, 3).some((d) => /animate-pulse|skeleton/.test(d.node))) rule = 'R4'
  else if (/feedback|don'?t see/i.test(said)) rule = 'R3'
  else if (/cannot|can'?t|does nothing|nothing happens/i.test(said)) rule = 'R2'
  if (!rule) { console.log(`no rule matched for ${t.key}`); continue }

  // R3 asserts around the last BUTTON click; drop trailing non-button steps
  let assertIdx = steps.length - 1
  if (rule === 'R3') {
    const bi = steps.map((s, i) => [/button/.test(s.s ?? '') ? i : -1]).flat().filter((i) => i >= 0).pop()
    if (bi === undefined) { console.log(`R3 but no button click for ${t.key}`); continue }
    steps = steps.slice(0, bi + 1); assertIdx = bi
  }

  const gaps = steps.map((s, i) => (i === 0 ? 800 : Math.min(1200, Math.max(150, s.at - steps[i - 1].at))))
  const lines = []
  lines.push(`// GENERATED repro — session ${DIR}, complaint: ${JSON.stringify(said)}`)
  lines.push(`// rule ${rule}; ${steps.length} recorded click(s); login preamble injected (typed input is masked in recordings)`)
  lines.push(`import { loadChromium } from '${path.resolve('lib/engine.mjs')}'`)
  lines.push(`const chromium = await loadChromium()`)
  lines.push(`const B = process.env.REPRO_BASE ?? '${BASE}'`)
  lines.push(`const browser = await chromium.launch()`)
  lines.push(`const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()`)
  lines.push(`page.setDefaultTimeout(9000)`)
  lines.push(`const out = (v, why) => { console.log(v + ': ' + why); browser.close().then(() => process.exit(v === 'FAIL' ? 1 : 0)) }`)
  lines.push(`const drift = (i, sel, e) => { console.log('DRIFT step ' + i + ' ' + sel + ' — ' + e.message.split('\\n')[0]); browser.close().then(() => process.exit(3)) }`)
  lines.push(`await page.goto(B + '/login')`)
  lines.push(`await page.fill('input[name=email]', 'ivor@ledger.local')`)
  lines.push(`await page.fill('input[name=password]', 'ledger')`)
  lines.push(`await page.click('form:has(input[name=password]) button[type=submit]')`)
  lines.push(`await page.waitForURL((u) => !u.pathname.includes('login'))`)
  lines.push(`await page.goto(B + '${appPath}')`)
  lines.push(`await page.waitForLoadState('networkidle')`)
  steps.forEach((s, i) => {
    lines.push(`await new Promise((r) => setTimeout(r, ${gaps[i]}))`)
    if (i === assertIdx && (rule === 'R3' || rule === 'R2')) {
      const scope = rule === 'R3' ? `document.querySelector('${esc(containerOf(s, 'body'))}') ?? document.body` : 'document.body'
      lines.push(`await page.evaluate(() => { window.__mut = 0 })`)
      lines.push(`await page.evaluate(() => { new MutationObserver((m) => { window.__mut += m.length }).observe(${scope}, { subtree: true, childList: true, attributes: true, characterData: true }) })`)
      lines.push(`const urlBefore = page.url()`)
    }
    lines.push(`try { await page.click('${esc(s.s)}', { timeout: 8000 }) } catch (e) { drift(${i + 1}, '${esc(s.s)}', e) }`)
  })
  if (rule === 'R1') {
    const container = containerOf(steps[steps.length - 1], 'aside')
    lines.push(`// expected behavior: the dismiss control's container goes away`)
    lines.push(`try { await page.waitForSelector('${esc(container)}', { state: 'hidden', timeout: 2000 }); out('PASS', 'container hid after dismiss click') }`)
    lines.push(`catch { out('FAIL', 'container "${esc(container)}" still visible 2s after clicking dismiss — bug reproduced') }`)
  } else if (rule === 'R4') {
    lines.push(`// expected behavior: no loading skeleton lingers after the step settles`)
    lines.push(`await new Promise((r) => setTimeout(r, 1500))`)
    lines.push(`const pulses = await page.$$eval('.animate-pulse', (els) => els.filter((el) => el.offsetParent !== null).length).catch(() => 0)`)
    lines.push(`if (pulses === 0) out('PASS', 'no visible loading skeleton 1.5s after the step')`)
    lines.push(`else out('FAIL', pulses + ' loading-skeleton node(s) still visible after 1.5s — bug reproduced')`)
  } else if (rule === 'R3') {
    lines.push(`// expected behavior: the click produces SOME feedback inside its container`)
    lines.push(`await new Promise((r) => setTimeout(r, 1500))`)
    lines.push(`const mut = await page.evaluate(() => window.__mut)`)
    lines.push(`if (mut >= 1) out('PASS', mut + ' mutation(s) inside the container — some feedback exists')`)
    lines.push(`else out('FAIL', 'zero DOM mutations inside the container within 1.5s of the click — no feedback, bug reproduced')`)
  } else if (rule === 'R2') {
    lines.push(`// expected behavior: clicking does SOMETHING — url change or a real DOM response`)
    lines.push(`await new Promise((r) => setTimeout(r, 1500))`)
    lines.push(`const mut = await page.evaluate(() => window.__mut)`)
    lines.push(`if (page.url() !== urlBefore || mut >= 3) out('PASS', 'click produced url change or ' + mut + ' mutations')`)
    lines.push(`else out('FAIL', 'no url change and only ' + mut + ' mutation(s) within 1.5s — dead control, bug reproduced')`)
  }
  const file = path.join(OUT, `repro-${t.key}.mjs`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  manifest.push({ key: t.key, said, rule, steps: steps.length, file })
  console.log(`${t.key}: rule ${rule}, ${steps.length} steps -> ${file}`)
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1))

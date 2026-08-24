// rewalk video — export a session's replay as a shareable mp4.
//
// replay.html is an interactive player; this drives it frame by frame instead
// of screen-recording it. Frame-stepping is exact: frame k IS replay time
// k/fps, so the session wav muxes on pure wall-clock arithmetic — no pre-roll,
// no screencast timing to reverse-engineer. The cost is speed (each goto()
// re-applies events from the last full snapshot, so long sessions step
// superlinearly); a share artifact is worth the wait.
//
// Wall-clock geometry: replay time 0 is the first playable event's timestamp
// (rrweb stamps Date.now), and the wav's sample 0 sits at clock.toWall(0).
// Positive skew delays the audio track; negative skew trims its head.
//
//   node bin/video.mjs <sessionDir> [outFile] [--fps N]
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { loadChromium } from '../lib/engine.mjs'
import { clockOf } from '../lib/utterances.mjs'
import { readPcm } from '../lib/align.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DIR = process.argv[2] ?? 'out/session7'
const OUT = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : path.join(DIR, 'replay.mp4')
const fpsIx = process.argv.indexOf('--fps')
const FPS = fpsIx >= 0 ? Number(process.argv[fpsIx + 1]) : 10
if (!Number.isFinite(FPS) || FPS <= 0) { console.error(`bad --fps`); process.exit(2) }

// Rebuild the player page when it is absent or predates the automation handle.
const replayHtml = path.join(DIR, 'replay.html')
if (!fs.existsSync(replayHtml) || !fs.readFileSync(replayHtml, 'utf8').includes('__rewalk')) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/replay.mjs'), DIR], { stdio: 'inherit' })
  if (r.status) process.exit(r.status)
}

// Audio, if the session has any. skew = where sample 0 falls on the replay axis.
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'session.json'), 'utf8'))
let wav = null, skewMs = 0
const probe = clockOf(meta)
if (probe && fs.existsSync(path.join(DIR, probe.file))) {
  wav = path.join(DIR, probe.file)
  const pcm = readPcm(wav)
  skewMs = clockOf(meta, (pcm.samples.length / pcm.sampleRate) * 1000).toWall(0)   // wall of sample 0; t0 subtracted below
}

const chromium = await loadChromium()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(pathToFileURL(path.resolve(replayHtml)).href)
await page.waitForFunction(() => window.__rewalk?.player, null, { timeout: 15000 })
const md = await page.evaluate(() => window.__rewalk.player.getMetaData())
if (wav) skewMs -= md.startTime
const totalMs = md.totalTime
const frames = Math.max(1, Math.ceil((totalMs / 1000) * FPS))
console.log(`${(totalMs / 1000).toFixed(1)}s of replay -> ${frames} frames at ${FPS}fps` +
  (wav ? `, audio skew ${(skewMs / 1000).toFixed(2)}s` : ', no audio'))

const tmp = fs.mkdtempSync(path.join(DIR, '.video-frames-'))
for (let k = 0; k < frames; k++) {
  await page.evaluate((t) => { window.__rewalk.player.goto(t, false) }, Math.min(k * (1000 / FPS), totalMs))
  await page.waitForTimeout(20)
  await page.screenshot({ path: path.join(tmp, `f${String(k).padStart(6, '0')}.png`) })
  if (k % 100 === 0 && k) console.log(`  frame ${k}/${frames}`)
}
await browser.close()

const args = ['-y', '-framerate', String(FPS), '-i', path.join(tmp, 'f%06d.png')]
if (wav) {
  if (skewMs < 0) args.push('-ss', (-skewMs / 1000).toFixed(3))
  args.push('-i', wav)
  if (skewMs > 0) args.push('-af', `adelay=${Math.round(skewMs)}:all=1`)
  args.push('-c:a', 'aac', '-b:a', '96k')
}
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-t', (frames / FPS).toFixed(3), OUT)
const ff = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
fs.rmSync(tmp, { recursive: true, force: true })
if (ff.status) { console.error(`ffmpeg failed:\n${ff.stderr.toString().slice(-1500)}`); process.exit(1) }
console.log(`${OUT}  ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)}MB  ${(frames / FPS).toFixed(1)}s${wav ? ' with audio' : ''}`)

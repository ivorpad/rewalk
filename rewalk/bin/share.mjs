// rewalk share — assemble the shareable set for one session.
//
// Copies video + replay.html + agent metadata (resolved.json, located.json,
// session.json) into one timestamped folder at the configured artifact dest.
// Does not rewrite the session directory. Pass --zip for a .zip next to it.
//
//   node bin/share.mjs <session> [--zip]
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadConfig, resolveSessionDir } from '../lib/config.mjs'
import { assembleShare, shouldExportVideo, exportVideo } from '../lib/artifacts.mjs'

const args = process.argv.slice(2).filter((a) => a !== '--zip')
const wantZip = process.argv.includes('--zip')
if (!args[0]) { console.error('rewalk share <session> [--zip]'); process.exit(2) }

const cfg = loadConfig()
const dir = resolveSessionDir(args[0], cfg)
if (!fs.existsSync(path.join(dir, 'session.json'))) {
  console.error(`not a session directory: ${dir}`); process.exit(2)
}

if (shouldExportVideo(cfg) && !fs.existsSync(path.join(dir, 'replay.mp4'))) {
  if (!fs.existsSync(path.join(dir, 'replay.html'))) {
    console.error(`no replay.html in ${dir} — run rewalk replay first`)
    process.exit(2)
  }
  console.log('no replay.mp4; exporting video...')
  const code = await exportVideo(dir)
  if (code !== 0) console.error(`video export failed (exit ${code}) — sharing without mp4`)
}

const { folder, stem } = assembleShare(dir, { cfg })
let printed = folder
if (wantZip) {
  const zipPath = `${folder}.zip`
  const z = spawnSync('zip', ['-r', '-q', zipPath, path.basename(folder)], {
    cwd: path.dirname(folder), encoding: 'utf8',
  })
  if (z.status) { console.error(`zip failed: ${z.stderr || z.status}`); process.exit(1) }
  printed = zipPath
}
console.log(printed)
console.log(`share ${stem} -> ${printed}`)

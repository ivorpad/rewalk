// Copy finished session artifacts to the configured destination with
// timestamped, self-identifying names. Session dirs themselves are not
// rewritten — old recordings stay byte-identical.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactStem, loadConfig, sessionStampMs } from './config.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const BUNDLE_FILES = ['resolved.json', 'located.json', 'session.json']

/**
 * @param {string} sessionDir
 * @param {import('./config.mjs').RewalkConfig} [cfg]
 */
export function stemFor(sessionDir, cfg) {
  return artifactStem(sessionDir, sessionStampMs(sessionDir))
}

/**
 * Copy one kind of artifact. Missing sources are skipped, not invented.
 * @param {string} sessionDir
 * @param {'video'|'replay'|'bundle'} kind
 * @param {string} destDir
 * @param {string} stem
 * @returns {string[]}
 */
export function copyArtifact(sessionDir, kind, destDir, stem) {
  fs.mkdirSync(destDir, { recursive: true })
  const out = []
  if (kind === 'video') {
    const src = path.join(sessionDir, 'replay.mp4')
    if (!fs.existsSync(src)) return out
    const to = path.join(destDir, `${stem}.mp4`)
    fs.copyFileSync(src, to)
    out.push(to)
  } else if (kind === 'replay') {
    const src = path.join(sessionDir, 'replay.html')
    if (!fs.existsSync(src)) return out
    const to = path.join(destDir, `${stem}.html`)
    fs.copyFileSync(src, to)
    out.push(to)
  } else if (kind === 'bundle') {
    const dir = path.join(destDir, `${stem}-meta`)
    let any = false
    for (const f of BUNDLE_FILES) {
      const src = path.join(sessionDir, f)
      if (!fs.existsSync(src)) continue
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(src, path.join(dir, f))
      any = true
    }
    if (any) out.push(dir)
  }
  return out
}

/**
 * Finish-time routing: whatever `artifacts.copy` lists, into `artifacts.dest`.
 * @param {string} sessionDir
 * @param {{ cfg?: import('./config.mjs').RewalkConfig, log?: (m: string) => void }} [opts]
 */
export function publishFinished(sessionDir, { cfg = loadConfig(), log = console.log } = {}) {
  const stem = stemFor(sessionDir)
  const dest = cfg.artifacts.dest
  const copied = []
  for (const kind of cfg.artifacts.copy) {
    copied.push(...copyArtifact(sessionDir, kind, dest, stem))
  }
  for (const p of copied) log(`artifact -> ${p}`)
  return { stem, dest, copied }
}

/**
 * Share-time routing: the full set (video + replay + agent metadata) in one
 * timestamped folder at the configured dest.
 * @param {string} sessionDir
 * @param {{ cfg?: import('./config.mjs').RewalkConfig }} [opts]
 */
export function assembleShare(sessionDir, { cfg = loadConfig() } = {}) {
  const stem = stemFor(sessionDir)
  const folder = path.join(cfg.artifacts.dest, stem)
  fs.mkdirSync(folder, { recursive: true })
  const copied = []
  copied.push(...copyArtifact(sessionDir, 'video', folder, stem))
  copied.push(...copyArtifact(sessionDir, 'replay', folder, stem))
  copied.push(...copyArtifact(sessionDir, 'bundle', folder, stem))
  // Flatten the meta dir into the share folder so one directory is the bundle.
  const meta = path.join(folder, `${stem}-meta`)
  if (fs.existsSync(meta)) {
    for (const f of fs.readdirSync(meta)) {
      fs.renameSync(path.join(meta, f), path.join(folder, f))
    }
    fs.rmdirSync(meta)
  }
  return { stem, folder, copied, result: folder }
}

export function shouldExportVideo(cfg = loadConfig()) {
  return cfg.artifacts.exportVideo && process.env.REWALK_NO_VIDEO !== '1'
}

export async function exportVideo(sessionDir) {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve) => {
    spawn(process.execPath, [path.join(ROOT, 'bin/video.mjs'), sessionDir], { stdio: 'inherit' })
      .on('exit', (code) => resolve(code ?? 1))
  })
}

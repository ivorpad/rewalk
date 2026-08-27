// ~/.config/rewalk/config.json — user routing for sessions and finished artifacts.
//
// Missing file = today's behavior: sessions in <product>/out, video export on,
// a copy of the mp4 in ~/Downloads. The file is optional; every reader merges
// against DEFAULTS so a partial config is valid.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()

/** @returns {string} */
export function configDir() {
  return process.env.REWALK_CONFIG_DIR
    ?? path.join(HOME, '.config', 'rewalk')
}

/** @returns {string} */
export function configPath() {
  return process.env.REWALK_CONFIG
    ?? path.join(configDir(), 'config.json')
}

/**
 * @typedef {object} RewalkArtifactsConfig
 * @property {string} dest
 * @property {string[]} copy
 * @property {boolean} exportVideo
 */

/**
 * @typedef {object} RewalkRecordConfig
 * @property {boolean} voice
 */

/**
 * @typedef {object} RewalkConfig
 * @property {string} sessionsDir
 * @property {RewalkArtifactsConfig} artifacts
 * @property {RewalkRecordConfig} record
 */

/** @type {RewalkConfig} */
export const DEFAULTS = {
  sessionsDir: path.join(ROOT, 'out'),
  artifacts: {
    dest: path.join(HOME, 'Downloads'),
    copy: ['video'],
    exportVideo: true,
  },
  // Voice is what the toolbar button asks the daemon for. Recording the DOM is
  // useful on its own — a comment backed by a replay needs the DOM stream and
  // nothing else — and a microphone that turns itself on because you wanted a
  // replay is the wrong default for anyone who is not narrating. Set false to
  // make every toolbar recording DOM-only; the context menu overrides per
  // session either way.
  record: { voice: true },
}

/** @param {string} p */
export function expandHome(p) {
  if (p == null || p === '') return p
  if (p === '~') return HOME
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2))
  return p
}

/**
 * @param {unknown} raw
 * @returns {RewalkConfig}
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const art = src.artifacts && typeof src.artifacts === 'object'
    ? /** @type {Record<string, unknown>} */ (src.artifacts) : {}
  const copyRaw = art.copy
  const copy = Array.isArray(copyRaw)
    ? copyRaw.map(String).filter((k) => k === 'video' || k === 'replay' || k === 'bundle')
    : [...DEFAULTS.artifacts.copy]
  const rec = src.record && typeof src.record === 'object'
    ? /** @type {Record<string, unknown>} */ (src.record) : {}
  return {
    sessionsDir: expandHome(typeof src.sessionsDir === 'string' && src.sessionsDir
      ? src.sessionsDir : DEFAULTS.sessionsDir),
    artifacts: {
      dest: expandHome(typeof art.dest === 'string' && art.dest ? art.dest : DEFAULTS.artifacts.dest),
      copy: copy.length ? copy : [...DEFAULTS.artifacts.copy],
      exportVideo: typeof art.exportVideo === 'boolean' ? art.exportVideo : DEFAULTS.artifacts.exportVideo,
    },
    record: { voice: typeof rec.voice === 'boolean' ? rec.voice : DEFAULTS.record.voice },
  }
}

/** @returns {RewalkConfig} */
export function loadConfig() {
  const p = configPath()
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(p, 'utf8')))
  } catch (e) {
    return normalizeConfig({})
  }
}

/** @returns {RewalkConfig} */
export function defaultConfigFile() {
  return {
    sessionsDir: DEFAULTS.sessionsDir,
    artifacts: {
      dest: '~/Downloads',
      copy: ['video'],
      exportVideo: true,
    },
    record: { voice: true },
  }
}

/**
 * Write DEFAULTS (as a documented file) if none exists. Does not overwrite.
 * @param {string} [dest]
 * @returns {{ path: string, wrote: boolean }}
 */
export function ensureConfigFile(dest = configPath()) {
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
  if (fs.existsSync(dest)) return { path: dest, wrote: false }
  fs.writeFileSync(dest, JSON.stringify(defaultConfigFile(), null, 2) + '\n', { mode: 0o644 })
  return { path: dest, wrote: true }
}

/** Directory that holds session folders and the .rewalk-* control files. */
export function sessionsDir(cfg = loadConfig()) {
  return cfg.sessionsDir
}

/**
 * Resolve a session argument: absolute path, cwd-relative path, or a name
 * under sessionsDir (and, as a last look, the product out/ so `out/session7`
 * and `session7` both keep working).
 * @param {string} arg
 * @param {RewalkConfig} [cfg]
 * @returns {string}
 */
export function resolveSessionDir(arg, cfg = loadConfig()) {
  if (!arg) throw new Error('session path or name required')
  const abs = path.resolve(arg)
  if (fs.existsSync(abs)) return abs
  const named = path.join(cfg.sessionsDir, arg)
  if (fs.existsSync(named)) return named
  const product = path.join(ROOT, 'out', path.basename(arg))
  if (fs.existsSync(product)) return product
  throw new Error(`no session at ${arg} (looked in ${abs}, ${named}, ${product})`)
}

/**
 * Compact local timestamp for filenames: 2026-08-26T09-30
 * @param {number} [ms]
 */
export function compactStamp(ms = Date.now()) {
  const d = new Date(ms)
  /** @param {number} n */
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}`
}

/**
 * Self-identifying artifact stem: rewalk-2026-08-26T09-30-ext-1787668028307
 * @param {string} sessionDir
 * @param {number} [ms]
 */
export function artifactStem(sessionDir, ms = Date.now()) {
  const id = path.basename(path.resolve(sessionDir)).replace(/[^\w.-]+/g, '-')
  return `rewalk-${compactStamp(ms)}-${id}`
}

/**
 * Wall time to stamp from, preferring the session's own clocks.
 * @param {string} sessionDir
 * @returns {number}
 */
export function sessionStampMs(sessionDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
    if (Number.isFinite(j.endedWall)) return j.endedWall
    if (Number.isFinite(j.browserReadyWall)) return j.browserReadyWall
  } catch (e) {}
  try { return fs.statSync(sessionDir).mtimeMs } catch (e) { return Date.now() }
}

export { ROOT as PRODUCT_ROOT }

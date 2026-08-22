// Pick the microphone the person actually chose, and notice when they change it.
//
// The first version of this hardcoded avfoundation index :4. That is wrong in
// two independent ways. Indices shift when hardware appears or disappears, so
// the index that meant "my good microphone" yesterday can mean the webcam
// today. And the device someone expects to be recorded is whichever one they
// selected in System Settings, which no index can tell you.
//
// So CoreAudio is asked for the default input, by name and by UID, and a
// property listener says when that changes. The ffmpeg index is looked up from
// the name at the moment it is needed and never cached across a device change.

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SWIFT = path.join(HERE, 'mac', 'default-input.swift')
const HELPER = path.join(HERE, 'mac', 'default-input')

/**
 * Build the CoreAudio helper on first use; it is a single file and ~1s.
 *
 * The binary is committed, so the question is when to distrust it. Comparing
 * mtimes does not answer that: git does not preserve mtimes, so after a fresh
 * clone both files carry checkout time and which one wins is a coin flip. And
 * an mtime says nothing at all about the architecture -- the committed binary
 * is arm64, and on an Intel machine it would lose that coin flip half the time
 * and be executed the other half.
 *
 * So ask the binary instead of asking the filesystem: run it, and rebuild
 * unless it answers. That covers a stale build, a wrong-architecture build and
 * a corrupted one with the same check, and it is the same principle as hashing
 * a bundle rather than grepping it for an identifier.
 */
export function ensureHelper() {
  if (process.platform !== 'darwin') return null
  if (fs.existsSync(HELPER) && fs.statSync(HELPER).mtimeMs >= fs.statSync(SWIFT).mtimeMs && helperAnswers()) return HELPER
  const r = spawnSync('swiftc', ['-O', '-o', HELPER, SWIFT], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`could not build default-input helper: ${r.stderr || r.stdout}`)
  if (!helperAnswers())
    throw new Error(`default-input helper built but does not run; delete ${HELPER} and rebuild by hand`)
  return HELPER
}

/** Does the committed binary actually execute on this machine and reply? */
function helperAnswers() {
  const r = spawnSync(HELPER, [], { encoding: 'utf8', timeout: 5000 })
  // Wrong architecture is an exec failure ("Bad CPU type"), not a bad exit code.
  if (r.error || r.status !== 0) return false
  try { return JSON.parse(String(r.stdout).trim().split('\n')[0]).ok !== undefined }
  catch (e) { return false }
}

/** {ok, name, uid, inputChannels} for the system default microphone. */
export function defaultInput() {
  if (process.platform !== 'darwin')
    return { ok: false, reason: `no default-input implementation for ${process.platform}` }
  const out = execFileSync(ensureHelper(), [], { encoding: 'utf8' }).trim().split('\n')[0]
  return JSON.parse(out)
}

/**
 * Call back whenever the system default input changes. Returns a stop function.
 * Fires once immediately with the current device, so callers have one code path
 * rather than a special case for startup.
 */
export function watchDefaultInput(onChange) {
  if (process.platform !== 'darwin') return () => {}
  const p = spawn(ensureHelper(), ['--watch'], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = '', last = null
  p.stdout.on('data', (d) => {
    buf += d
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      if (!l.trim()) continue
      try {
        const dev = JSON.parse(l)
        // uid, not name: two identical models carry the same name.
        if (dev.uid !== last) { last = dev.uid; onChange(dev) }
      } catch (e) { /* a partial line is not an error worth surfacing */ }
    }
  })
  return () => { try { p.kill() } catch (e) {} }
}

/** Every avfoundation audio device, in the order ffmpeg indexes them. */
export function avfoundationInputs() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    { encoding: 'utf8' })
  const text = `${r.stderr ?? ''}${r.stdout ?? ''}`
  const out = []
  let inAudio = false
  for (const line of text.split('\n')) {
    if (/AVFoundation audio devices/.test(line)) { inAudio = true; continue }
    if (/AVFoundation video devices/.test(line)) { inAudio = false; continue }
    if (!inAudio) continue
    const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line.replace(/^\[[^\]]*\]\s*/, ''))
    if (m) out.push({ index: Number(m[1]), name: m[2] })
  }
  return out
}

/**
 * The ffmpeg input spec for the current default microphone.
 * Resolved at the moment of use; never cached across a device change.
 */
export function defaultMicSpec() {
  const dev = defaultInput()
  if (!dev.ok) return { ok: false, reason: dev.reason ?? 'no default input' }
  const list = avfoundationInputs()
  const exact = list.find((d) => d.name === dev.name)
  // avfoundation truncates some names; fall back to a prefix match before
  // giving up, but never to "just use index 0", which is how you silently
  // record the wrong device for three minutes.
  const loose = exact ?? list.find((d) => dev.name.startsWith(d.name) || d.name.startsWith(dev.name))
  if (!loose) return { ok: false, reason: `default input "${dev.name}" not in avfoundation list`, device: dev, list }
  return { ok: true, spec: `:${loose.index}`, index: loose.index, name: dev.name, uid: dev.uid,
    inputChannels: dev.inputChannels, matchedLoosely: !exact }
}

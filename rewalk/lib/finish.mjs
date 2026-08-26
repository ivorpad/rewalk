// Finish a paired session directory: merge the host's and the companion's
// metadata into one session.json, resolve speech against DOM (read), build the
// replay, and hand it to the human. Shared by bin/session.mjs (opens the
// replay in the foreground terminal flow) and bin/daemon.mjs (posts a macOS
// notification that opens it), so the two routes end byte-identically.
/** @typedef {import('./types.js').SessionJson} SessionJson */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { readStream } from './deltas.mjs'
import { loadConfig } from './config.mjs'
import { publishFinished, shouldExportVideo } from './artifacts.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/**
 * @param {string} absOut
 * @param {{ startedWall?: number, open?: boolean, notify?: boolean, log?: (m: string) => void }} [opts]
 * @returns {Promise<SessionJson>}
 */
export async function finishSession(absOut, { startedWall, open = false, notify = false, log = console.log } = {}) {
  const audioMeta = readJson(path.join(absOut, 'audio-meta.json')) ?? {}
  const hostMeta = readJson(path.join(absOut, 'session.json')) ?? {}
  let url = hostMeta.url ?? null
  const eventsPath = path.join(absOut, 'events.ndjson')
  let events = 0
  if (fs.existsSync(eventsPath)) {
    const ev = readStream(fs.readFileSync(eventsPath, 'utf8'))
    events = ev.length
    if (!url) { const meta = ev.find((e) => e.type === 4); url = meta?.data?.href ?? null }
  }
  const merged = { url, via: 'session', browserReadyWall: hostMeta.browserReadyWall ?? startedWall,
    endedWall: Date.now(), events, mic: audioMeta.mic ?? [], audioClocks: audioMeta.audioClocks ?? [],
    utterances: audioMeta.utterances ?? 0, streamed: !!audioMeta.streamed }
  fs.writeFileSync(path.join(absOut, 'session.json'), JSON.stringify(merged, null, 1))

  log(`session: ${events} DOM events, ${merged.utterances} utterances, ${merged.audioClocks.length} audio clock(s)`)
  if (!events) { log(`nothing to resolve yet. Both halves must record: ${absOut}`); return merged }

  if (merged.utterances || merged.audioClocks.length) {
    log(`reading back:`)
    await run(process.execPath, [path.join(ROOT, 'bin/read.mjs'), absOut])
  }
  await run(process.execPath, [path.join(ROOT, 'bin/replay.mjs'), absOut])
  const replay = path.join(absOut, 'replay.html')
  if (fs.existsSync(replay) && process.platform === 'darwin' && process.env.REWALK_NO_OPEN !== '1') {
    if (open) spawn('open', [replay], { stdio: 'ignore', detached: true }).unref()
    if (notify) notifyReplay(replay, merged, path.basename(absOut))
  }

  // After the replay notification: frame-stepping takes minutes and the
  // interactive replay should not wait on it. Dest, which files, and whether
  // to export at all come from ~/.config/rewalk/config.json (defaults match
  // the old hardcoded ~/Downloads mp4 copy).
  const cfg = loadConfig()
  if (fs.existsSync(replay) && shouldExportVideo(cfg)) {
    log(`exporting video:`)
    const code = await run(process.execPath, [path.join(ROOT, 'bin/video.mjs'), absOut])
    const mp4 = path.join(absOut, 'replay.mp4')
    if (code !== 0 || !fs.existsSync(mp4)) log(`video export failed (exit ${code}) — replay.html still works`)
  }
  try {
    const published = publishFinished(absOut, { cfg, log })
    const videoCopy = published.copied.find((p) => p.endsWith('.mp4'))
    if (notify && videoCopy) notifyVideo(videoCopy, path.basename(absOut))
  } catch (e) { log(`could not copy artifacts: ${e instanceof Error ? e.message : String(e)}`) }
  return merged
}

// terminal-notifier gives the notification a click action (-open); without it,
// osascript can still announce but not open, so the path is in the message.
/** @param {string} replay @param {SessionJson} merged @param {string} name */
function notifyReplay(replay, merged, name) {
  const msg = `${merged.events} DOM events, ${merged.utterances} utterances — click to watch`
  const tn = spawnSync('terminal-notifier',
    ['-title', 'rewalk', '-subtitle', name, '-message', msg, '-open', 'file://' + replay], { stdio: 'ignore' })
  if (tn.error) spawnSync('osascript',
    ['-e', `display notification ${JSON.stringify(`${msg}: ${replay}`)} with title "rewalk"`], { stdio: 'ignore' })
}

/** @param {string} mp4 @param {string} name */
function notifyVideo(mp4, name) {
  const tn = spawnSync('terminal-notifier',
    ['-title', 'rewalk', '-subtitle', name, '-message', 'video ready — click to play', '-open', 'file://' + mp4], { stdio: 'ignore' })
  if (tn.error) spawnSync('osascript',
    ['-e', `display notification ${JSON.stringify(`video ready: ${mp4}`)} with title "rewalk"`], { stdio: 'ignore' })
}

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) { return new Promise((resolve) => spawn(cmd, args, { stdio: 'inherit' }).on('exit', resolve)) }
/** @param {string} p */
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }

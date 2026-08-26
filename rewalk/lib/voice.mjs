// Live voice capture into a session directory: the signed bundle writes the
// wav, a tail streams new bytes to Deepgram live, utterances come back
// wall-stamped. This is bin/stream-audio.mjs's live path factored out, so the
// login daemon (bin/daemon.mjs) records exactly the same artifacts and the
// readers never learn which process held the microphone.
import fs from 'node:fs'
import path from 'node:path'
import { BundleMic, bundleAvailable } from './mac/bundle-mic.mjs'
import { fitProgressClock } from './record.mjs'
import { openDeepgramStream } from './dg-stream.mjs'

/** The extension host's last act is writing session.json (via:'extension')
 *  into the shared dir. That file appearing after sinceWall is the stop
 *  signal; the mtime guard ignores one that predates this recording. */
export function hostFinalized(dir, sinceWall) {
  try {
    const p = path.join(dir, 'session.json')
    if (fs.statSync(p).mtimeMs < sinceWall) return false
    return JSON.parse(fs.readFileSync(p, 'utf8')).via === 'extension'
  } catch (e) { return false }
}

/** Record until stopWhen() is true; write utterances.ndjson + audio-meta.json.
 *  Throws before any file is written if the mic is refused.
 *
 *  maxMs is a failsafe, not a feature: the stop signal is a file another
 *  process must write, and when that process dies mid-session nothing ever
 *  writes it. Measured 2026-08-25: a session whose stop click never landed
 *  left the daemon capturing for ~10 hours — 1.2GB of room audio on disk,
 *  all of it streamed live to Deepgram. No recording is legitimately longer
 *  than the cap; one that hits it was already abandoned. */
export async function recordVoice(dir, { stopWhen, onUtterance = () => {}, onEvent = () => {}, audition = true,
  maxMs = Number(process.env.REWALK_MAX_VOICE_MS) || 2 * 3600_000 } = {}) {
  if (!bundleAvailable()) throw new Error('rewalk-mic.app is not built (see lib/mac/rewalk-mic-src/README.md)')
  // No key: still write the wav. Live utterances need Deepgram; without it
  // the session is DOM + audio and read/replay can transcribe later (or not).
  let dg = null
  try { dg = openDeepgramStream({ onUtterance }) }
  catch (e) { onEvent({ kind: 'stt-skip', reason: e.message }) }
  const startedWall = Date.now()
  let mic
  try { mic = await new BundleMic(dir, { onEvent }).startAsync({ audition }) }
  catch (e) { try { await dg.finish() } catch (x) {} throw e }
  const wav = mic.segments[0].file
  // One capture, two consumers: the bundle owns the durable wav, the tail
  // streams whatever bytes are new. No change to the signed bundle.
  let sent = 0
  const tail = setInterval(() => {
    try {
      const sz = fs.statSync(wav).size, start = Math.max(44, sent || 44)
      if (sz > start) { const fd = fs.openSync(wav, 'r'); const b = Buffer.alloc(sz - start); fs.readSync(fd, b, 0, b.length, start); fs.closeSync(fd); if (dg) dg.push(b); sent = sz }
    } catch (e) {}
  }, 200)
  while (!stopWhen()) {
    if (Date.now() - startedWall > maxMs) {
      onEvent({ kind: 'failsafe-stop', reason: `no stop signal after ${Math.round(maxMs / 60000)} minutes — abandoning capture` })
      break
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  clearInterval(tail)
  const segs = await mic.stop()
  const clocks = mic.segments.map((s) => { const f = fitProgressClock(s.ticks); return { file: path.basename(s.file), ...(f.ok ? f : { ok: false, reason: f.reason }), toWall: undefined } })
  const utts = dg ? await dg.finish() : []
  return writeVoiceArtifacts(dir, { startedWall, segs, clocks, utts })
}

/** Stamp utterances onto the wall clock and write the companion's two files. */
export function writeVoiceArtifacts(dir, { startedWall, segs, clocks, utts }) {
  const clk = clocks.find((c) => c.ok)
  const a = 1 + ((clk?.driftPpm ?? 0) / 1e6), b = clk?.startWall ?? startedWall
  const stamped = utts.map((u) => ({ ...u, wall: Math.round(a * u.from + b) }))
  fs.writeFileSync(path.join(dir, 'utterances.ndjson'), stamped.map((u) => JSON.stringify(u)).join('\n') + (stamped.length ? '\n' : ''))
  fs.writeFileSync(path.join(dir, 'audio-meta.json'), JSON.stringify(
    { startedWall, endedWall: Date.now(), kind: 'rewalk-audio-companion', streamed: true, mic: segs, audioClocks: clocks, utterances: stamped.length }, null, 1))
  return { segs, clocks, utterances: stamped }
}

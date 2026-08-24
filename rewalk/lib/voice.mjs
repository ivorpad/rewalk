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
 *  Throws before any file is written if the mic is refused. */
export async function recordVoice(dir, { stopWhen, onUtterance = () => {}, onEvent = () => {}, audition = true } = {}) {
  if (!bundleAvailable()) throw new Error('rewalk-mic.app is not built (see lib/mac/rewalk-mic-src/README.md)')
  const dg = openDeepgramStream({ onUtterance })
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
      if (sz > start) { const fd = fs.openSync(wav, 'r'); const b = Buffer.alloc(sz - start); fs.readSync(fd, b, 0, b.length, start); fs.closeSync(fd); dg.push(b); sent = sz }
    } catch (e) {}
  }, 200)
  while (!stopWhen()) await new Promise((r) => setTimeout(r, 400))
  clearInterval(tail)
  const segs = await mic.stop()
  const clocks = mic.segments.map((s) => { const f = fitProgressClock(s.ticks); return { file: path.basename(s.file), ...(f.ok ? f : { ok: false, reason: f.reason }), toWall: undefined } })
  const utts = await dg.finish()
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

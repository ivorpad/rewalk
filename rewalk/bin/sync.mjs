// rewalk sync — join a DOM recording and a voice recording into one session.
//
// The extension records DOM (events.ndjson, rrweb wall timestamps). The
// companion records voice (audio.1.wav + wall-stamped clock ticks). Both ran on
// one machine against one Date.now, so the join is by wall clock and needs no
// beacon: the audio clock already maps audioMs -> wall, and the DOM events are
// already in wall time, so an utterance's wall time indexes straight into the
// DOM stream. This copies the audio beside the DOM and writes the session.json
// the readers expect, so read/replay/locate/score then work unchanged.
//
//   node bin/sync.mjs <domDir> <audioDir> [outDir]
import fs from 'node:fs'
import path from 'node:path'

const domDir = process.argv[2], audioDir = process.argv[3]
const outDir = process.argv[4] ?? `${domDir.replace(/\/$/, '')}-synced`
if (!domDir || !audioDir) { console.error('usage: node bin/sync.mjs <domDir> <audioDir> [outDir]'); process.exit(2) }

const dom = JSON.parse(fs.readFileSync(path.join(domDir, 'session.json'), 'utf8'))
const aud = JSON.parse(fs.readFileSync(path.join(audioDir, 'audio-meta.json'), 'utf8'))

// Sanity: the two recordings should overlap in wall time. A non-overlap almost
// always means the wrong pair was handed in, and silently "aligning" them would
// place every utterance against unrelated DOM. Warn rather than pretend.
const dStart = dom.browserReadyWall ?? 0, dEnd = dom.endedWall ?? Infinity
const aStart = aud.startedWall ?? 0, aEnd = aud.endedWall ?? Infinity
const overlap = Math.min(dEnd, aEnd) - Math.max(dStart, aStart)
if (!(overlap > 0)) console.warn(`WARNING: DOM and audio windows do not overlap (gap ${Math.round(-overlap/1000)}s) — are these the same session?`)

fs.mkdirSync(outDir, { recursive: true })
fs.copyFileSync(path.join(domDir, 'events.ndjson'), path.join(outDir, 'events.ndjson'))
for (const c of aud.audioClocks ?? []) {
  const src = path.join(audioDir, c.file)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, c.file))
}
// A streaming companion already produced wall-stamped utterances; carry them so
// read uses them directly instead of re-transcribing.
const uttSrc = path.join(audioDir, 'utterances.ndjson')
if (fs.existsSync(uttSrc)) fs.copyFileSync(uttSrc, path.join(outDir, 'utterances.ndjson'))

// The merged session.json: DOM metadata plus the companion's audio clocks,
// which are already on the shared wall clock, so no offset is applied.
const merged = { ...dom, via: 'extension+companion',
  audioSource: { domDir: path.resolve(domDir), audioDir: path.resolve(audioDir), overlapMs: Math.round(overlap) },
  mic: aud.mic ?? [], audioClocks: aud.audioClocks ?? [] }
fs.writeFileSync(path.join(outDir, 'session.json'), JSON.stringify(merged, null, 1))

const clk = (aud.audioClocks ?? []).find((c) => c.ok)
console.log(`synced -> ${outDir}`)
console.log(`  DOM ${fs.readFileSync(path.join(outDir,'events.ndjson'),'utf8').trim().split('\n').length} events` +
  ` (${new Date(dStart).toISOString()} .. ${new Date(dEnd).toISOString()})`)
console.log(`  audio ${(aud.audioClocks??[]).map(c=>c.file).join(', ') || 'none'}` +
  (clk ? `, clock ok (drift ${clk.driftPpm}ppm, residual ${clk.residualMs}ms)` : ', no usable clock'))
console.log(`  overlap ${Math.round(overlap/1000)}s`)
console.log(`\nnext: REWALK_STT=deepgram node bin/read.mjs ${outDir}`)

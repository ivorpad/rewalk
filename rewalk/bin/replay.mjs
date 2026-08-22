// rewalk replay — play a human session back, with what they said on the timeline.
//
// The two halves of this repo were disjoint. `watch` writes events.ndjson and
// the analysis reads it as text; the only rrweb player in the tree is
// skill/scripts/build-viewer.mjs, which consumes run.json and replay/<flow>.json
// from the SCRIPTED runner and cannot see a human session at all. So the
// recording that carries a person's voice -- the thing this project exists to
// capture -- could be scored but never watched.
//
// This is that bridge. It packs the session's rrweb stream into a self-contained
// page and puts the utterances beside it: click a complaint and the player seeks
// to the moment it was said, with the deltas the join ranked for it.
//
//   node bin/replay.mjs <sessionDir> [outFile]
//   REWALK_STT=deepgram node bin/replay.mjs out/session7

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { readStream, buildMirror, extractDeltas, extractMarks, extractObserved, extractCues } from '../lib/deltas.mjs'
import { churnProfile, resolveUtterance } from '../lib/resolve.mjs'
import { transcribe, clockOf } from '../lib/utterances.mjs'
import { readPcm } from '../lib/align.mjs'

const DIR = process.argv[2] ?? 'out/session7'
const OUT = process.argv[3] ?? path.join(DIR, 'replay.html')

const PLAYER = new URL('../skill/node_modules/rrweb-player/dist/rrweb-player.umd.cjs', import.meta.url)
const PLAYER_CSS = new URL('../skill/node_modules/rrweb-player/dist/style.css', import.meta.url)
if (!fs.existsSync(PLAYER)) {
  console.error(`rewalk: rrweb-player is missing.\n  cd ${path.resolve('skill')} && npm install\n`)
  process.exit(3)
}

const events = readStream(fs.readFileSync(path.join(DIR, 'events.ndjson'), 'utf8'))
// rrweb refuses to play a stream that does not begin with a full snapshot, and
// a session finalised after a kill can carry incremental events before it.
const firstFull = events.findIndex((e) => e.type === 2)
if (firstFull < 0) { console.error('no full snapshot in this recording — nothing to play'); process.exit(2) }
const playable = events.slice(firstFull).filter((e) => e.type !== 5)
const t0 = playable[0].timestamp

const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'session.json'), 'utf8'))
const mirror = buildMirror(events)
const deltas = extractDeltas(events, mirror)
const { marks } = extractMarks(events)
const observed = extractObserved(events)
const churn = churnProfile(deltas, marks, observed)
const cues = extractCues(events).filter((c) => c.kind === 'say-start')

// Utterances, if there is audio. A session with no speech still replays.
let utterances = [], engine = null, clock = null
const probe = clockOf(meta)
if (probe && fs.existsSync(path.join(DIR, probe.file))) {
  const pcm = readPcm(path.join(DIR, probe.file))
  clock = clockOf(meta, (pcm.samples.length / pcm.sampleRate) * 1000)
  const t = await transcribe(DIR, clock.file)
  engine = `${t.engine}/${t.segment}`
  for (const f of t.failures) console.error(`region ${f.region ?? 'whole file'}: ${f.reason}`)
  utterances = t.utterances
}

const rows = []
for (const u of utterances) {
  if (u.text.split(/\s+/).length < 3) continue
  const at = clock.toWall(u.from)
  const r = resolveUtterance({ text: u.text, at }, { deltas, marks, churn })
  const list = r.query === 'stasis' ? (r.held.length ? r.held : r.deltas) : r.deltas
  // Which cue was on screen when this was said, if the fixture teleprompted it.
  const cue = cues.filter((c) => c.at <= at).pop()
  rows.push({ text: u.text, at, offset: at - t0, query: r.query, pointedAt: r.pointedAt ?? null,
    top: list.slice(0, 3).map((d) => ({ node: d.node, prop: d.prop, score: d.score,
      from: d.from ?? null, to: d.to ?? null,
      changed: d.changedInSteps !== undefined ? `${d.changedInSteps}/${d.ofSteps}` : null })),
    cue: cue ? { text: cue.text, want: `${cue.expect?.node} ${cue.expect?.prop}` } : null })
}

const packed = zlib.gzipSync(Buffer.from(JSON.stringify(playable)), { level: 9 }).toString('base64')
const html = `<!doctype html><meta charset=utf-8><title>rewalk replay — ${path.basename(DIR)}</title>
<style>
${fs.readFileSync(PLAYER_CSS, 'utf8')}
:root{--bg:#0e1116;--fg:#e6edf3;--dim:#8b949e;--line:#232a33;--hit:#3fb950;--card:#161b22}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;height:100vh;display:flex;flex-direction:column}
header{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:baseline;flex-wrap:wrap}
h1{font-size:14px;margin:0;font-weight:600}
.meta{color:var(--dim);font-size:12px}
main{flex:1;display:flex;min-height:0}
.stage{flex:1;display:flex;align-items:center;justify-content:center;padding:14px;min-width:0;overflow:auto}
aside{width:390px;border-left:1px solid var(--line);overflow-y:auto;padding:10px}
.u{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:9px;cursor:pointer}
.u:hover{border-color:#3d4753}
.u .t{font-size:12px;color:var(--dim);margin-bottom:4px;display:flex;justify-content:space-between;gap:8px}
.u .said{margin-bottom:7px}
.d{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);display:flex;gap:7px}
.d b{color:var(--fg);font-weight:600}
.d.first b{color:var(--hit)}
.cue{font-size:11px;color:#8957e5;margin-top:6px}
.empty{color:var(--dim);padding:14px}
.rr-block{background:#fff;border-radius:6px;overflow:hidden}
</style>
<header>
  <h1>rewalk replay</h1>
  <span class=meta>${path.basename(DIR)}</span>
  <span class=meta>${playable.length} events</span>
  <span class=meta>${rows.length} utterance${rows.length === 1 ? '' : 's'}${engine ? ` via ${engine}` : ''}</span>
  <span class=meta>${meta.url ?? ''}</span>
</header>
<main>
  <div class=stage><div class=rr-block id=player></div></div>
  <aside id=list></aside>
</main>
<script>${fs.readFileSync(PLAYER, 'utf8')}</script>
<script type="module">
const raw = atob(${JSON.stringify(packed)});
const bytes = new Uint8Array(raw.length);
for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
const ds = new DecompressionStream('gzip');
const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
const events = JSON.parse(new TextDecoder().decode(buf));

// The UMD bundle exports a namespace, not the constructor: skill/assets's
// viewer already had to learn this.
const Player = window.rrwebPlayer?.default ?? window.rrwebPlayer;
const player = new Player({
  target: document.getElementById('player'),
  props: { events, width: Math.min(1180, innerWidth - 430), height: Math.max(380, innerHeight - 150),
           autoPlay: false, showController: true },
});

const ROWS = ${JSON.stringify(rows)};
const list = document.getElementById('list');
if (!ROWS.length) list.innerHTML = '<div class=empty>No speech resolved in this recording.</div>';
for (const r of ROWS) {
  const el = document.createElement('div');
  el.className = 'u';
  el.innerHTML =
    '<div class=t><span>+' + (r.offset / 1000).toFixed(1) + 's</span><span>' + r.query +
      (r.pointedAt ? ' · pointed at ' + r.pointedAt : '') + '</span></div>' +
    '<div class=said>' + r.text.replace(/[<>&]/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</div>' +
    r.top.map((d, i) =>
      '<div class="d' + (i === 0 ? ' first' : '') + '"><span>' + d.score + '</span><b>' + d.node + ' ' + d.prop + '</b>' +
      (d.from != null ? '<span>' + d.from + ' → ' + d.to + '</span>' : '') +
      (d.changed ? '<span>changed ' + d.changed + '</span>' : '') + '</div>').join('') +
    (r.cue ? '<div class=cue>cue asked: “' + r.cue.text + '” → ' + r.cue.want + '</div>' : '');
  // Seek a little before the utterance: people describe a thing after it happens.
  el.onclick = () => { player.goto(Math.max(0, r.offset - 2500)); };
  list.appendChild(el);
}
</script>`

fs.writeFileSync(OUT, html)
console.log(`${OUT}  ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)}MB  ` +
  `${playable.length} events, ${rows.length} utterances${engine ? ` (${engine})` : ''}`)

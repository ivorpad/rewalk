# What a session directory contains

The data contract for `out/<session>/`. Every file is written as it arrives —
there is no write-at-exit path, so a killed session is a readable session.

Asked "what did the session find?", read in this order: `resolved.json`
(the findings), `located.json` (where in the repo they live), `replay.html`
(watch the moment), and `session.json` `audioClocks` + `dropRate` (whether the
timings deserve trust).

## events.ndjson

Writer: the injected recorder, batched every 250ms through the `Sink`
(append-only fd; `kill -9` costs at most the last 250ms).
Readers: everything — `deltas.mjs` (`buildMirror`/`extractDeltas`/
`extractMarks`/`extractObserved`/`extractCues`), `replay.mjs`.

rrweb events plus custom events (`type: 5`), one JSON object per line:

| tag | carries |
|---|---|
| `rewalk-clock` | `recorderElapsedMs` + `wall` every 2s — the page clock fit |
| `rewalk-rects` | layout-frame boxes for watched elements (scroll-invariant) |
| `rewalk-scroll` | scrollTop changes, first-class, per container |
| `rewalk-observe` | 4s heartbeat of what EXISTS — the stasis query's universe |
| `rewalk-motion` / `rewalk-motion-window` | settleMs, cancels, path vs net |
| `rewalk-mark` | click/alt-click: selector, 8-deep ancestor chain, and on React pages `react: {chain, anon, props}` — names surviving minification innermost-first, count of unnamed composites, prop keys (never values) of the innermost named client component |
| `rewalk-cue` | fixture teleprompter only: ready/step/say-start/say-end/finished |
| `rewalk-beacon` | only with `REWALK_BEACON=1` |

The stream must start `[Meta, FullSnapshot]` to replay — see sharp-edges.

## audio.N.wav

Writer: `Mic` (ffmpeg, 16k mono, `aresample=async=1` so file position equals
elapsed time). One file per device segment — unplugging a mic closes N and
opens N+1 with its own clock. Readers: `utterances.mjs` (transcription),
`align.mjs` (`readPcm`).

## utterances.ndjson, audio-meta.json (streamed sessions)

Writer: the voice companion (`bin/stream-audio.mjs` via `lib/voice.mjs`) or
the login daemon — sessions recorded through `session` or the toolbar button.
One wall-stamped utterance per line (`text`, `from`/`to` in audio ms, `wall`);
`audio-meta.json` carries the companion's `mic[]` + `audioClocks[]` until the
merge folds them into session.json. When utterances.ndjson exists,
`loadUtterances()` serves it to read/replay/walkthrough directly — Deepgram's
live boundaries, no second transcription pass, no `regions/` cache.

## session.json

Writer: `watch` (once at start, rewritten at stop — a crashed session has the
start version); on paired sessions the merge in `lib/finish.mjs` rewrites it
with `via: 'session'`. The extension host's version (`via: 'extension'`) is
also the stop signal the companion and daemon watch for. Reader: `clockOf()`
in `utterances.mjs`, and you.

Fields that matter:
- `audioClocks[]` — per segment: `ok`, `startWall` (wall time of sample 0),
  `driftPpm`, `residualMs`, `ticks`. Healthy: residual ~30ms over hundreds of
  ticks. `clockOf(meta, fileMs)` reconciles this against the actual file and
  returns `dropRate` — non-zero means the capture lost audio; distrust fine
  timing and see sharp-edges.
- `mic[]` — segments: file, device `{name, uid, spec}`, startedWall/endedWall,
  bytes, last 300 chars of ffmpeg stderr.
- `micEvents[]` — audition result (with dynamicRange), device changes, losses.

`micticks.json` holds the raw ffmpeg progress ticks per segment, enough to
refit the clock from scratch.

## regions/ (transcript cache)

Writer/reader: `transcribe()` in `utterances.mjs`. `rNNN.wav` clips cut by the
energy segmenter, plus per-engine transcripts: `rNNN.json` (whisper),
`rNNN.<model>.json` (deepgram per clip), `whole.<model>.json` (deepgram
whole-file words path). Caches are keyed by engine+model on purpose — two
engines never serve each other's text. Deleting forces re-transcription;
for deepgram that re-spends money.

## resolved.json

Writer: `bin/read.mjs`. The findings. Array, one entry per utterance:
`said`, `at` (wall ms), `window`, `query` (`motion` | `stasis`), `pointedAt`
(alt-click target if any), `interactions` in window (each carrying the mark's
`react` component info when the page captured it), `deltas[]` ranked
(`node`, `prop`, `from`, `to`, `score`, `changedInSteps`), `held[]` (stasis
candidates — things that stayed put while neighbours moved).

## located.json

Writer: `bin/locate.mjs <session> <repo>`. Per utterance: `sources[]` of
`{file, score, via[{token, kind, line}]}` — the token and line are the
evidence, so a claim can be checked before it is believed. Empty `sources`
means "no source located", reported as a miss rather than the nearest wrong
file. Test-ish paths are down-weighted 0.4x.

## replay.html

Writer: `bin/replay.mjs`. Self-contained (~0.5–0.7MB typical): the rrweb
player plus one card per utterance; clicking a card seeks to 2.5s before it
was said. Engine/segmentation shown in the header — rebuild with
`REWALK_STT=deepgram` for the better boundaries.

## replay.mp4

Writer: `bin/video.mjs`. The replay page frame-stepped into a shareable mp4
(frame k is replay time k/fps exactly), session audio muxed on the wall-clock
offset. Derived; rebuild any time.

## walkthrough.md

Writer: `bin/walkthrough.mjs`. Study notes for third-party sites: one section
per plain click, with the speech/⌥-points inside the step and the DOM regions
that changed before the next click. Steps and points carry their component
(⚛) when the recording captured one, and a "Components touched" index closes
the file: each component with its interaction count, what it sits inside, and
its prop keys. Step times deep-link into replay.html (`#t=<ms>`). Derived;
rebuild any time.

## score.<engine>-<segment>.json, stt-compare.json

Fixture sessions only — they need `rewalk-cue` ground truth stamped in the
recording. Absent on real-site sessions by design: no ground truth, no score.

## STOP

Not data. `touch out/<session>/STOP` ends a `watch` recording; on the
extension routes the toolbar button's second click is the stop, and STOP
remains the fallback.

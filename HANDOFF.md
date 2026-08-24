# rewalk — handoff, 2026-08-24 (second sitting)

Previous handoff is one commit behind ff44c36. Of its seven ranked items, this
sitting closed 1 (button-stop), 2 (voice daemon), 3 (video export), 5
(walkthrough) and 6 (skill update + eval iteration 2). Item 4 — a live paired
human run — still needs a human. Every claim below was measured this sitting;
where something is untested it says so.

## What this is for

Record a person using any web UI — DOM stream, their voice, alt-click pointing
— then: save a replay you can watch, resolve what they SAID to what the DOM
DID, and hand a coding agent the metadata (ranked deltas + candidate source
files) so it fixes the bug precisely instead of being told a story about it.

Two use cases drive the roadmap:
1. **Fix frontend bugs precisely** — record yourself hitting the bug in your
   own app; agent gets `resolved.json` + `located.json` + the replay.
2. **Learn how a feature is built on someone else's site** — record yourself
   using it in your real logged-in Chrome; `walkthrough.md` (new) is the study
   artifact: one section per click, speech inside the step, the DOM regions
   that changed before the next click, deep-linked into the replay.

## State: what works, with evidence

Recording routes, one session format — `read`/`replay`/`locate`/`score`/
`video`/`walkthrough` do not know which route recorded a session:

| route | what | proven |
|---|---|---|
| toolbar button only | daemon holds the mic; host writes `out/.rewalk-voice`, daemon records into the host's dir, stop click finishes everything, notification opens the replay | live with terminal-launched daemon: request picked up in one poll tick, mic started 23ms later, stop → merge → replay → notification exit 0. INSTALLED and live under launchd via the rewalk-voiced.app wrapper: `mic auditioned ok` (bare-node job first measured digitally silent — see platform facts) |
| `rewalk session` | one command; extension co-locates DOM; the stop click in Chrome ends everything and opens the replay — terminal touched once | live: simulated host finalization stopped the companion in <1s; merge saw 102 DOM events + 1 audio clock; replay built. From-wav path re-verified after each refactor (6 utterances, stasis → `#code scrollTop`) |
| chrome-ext (button) | DOM in the user's REAL Chrome, on demand, one tab | 553 events from openlogi.org (previous sitting) |
| `rewalk watch <url>` | CLI: Playwright Chromium + inline mic | 4/4 top-1 on real speech twice; 0.00% sample loss |

The chain after recording: `read` → `replay.html` (now with a `window.__rewalk`
automation handle and `#t=<ms>` deep links) → `locate <session> <repo>`, plus
two share/study artifacts: `video` (mp4 of the replay page, frame-stepped so
frame k IS replay time k/fps, wav muxed on the wall-clock offset — session7's
38.2s export pixel-verified) and `walkthrough` (verified on session7 with
speech and on the speechless openlogi session).

Speech loading is ONE function now — `loadUtterances` in `lib/utterances.mjs`
(streamed `utterances.ndjson` first, batch transcription fallback); read,
replay and walkthrough share it and cannot disagree. Likewise `lib/voice.mjs`
(the live capture loop) is shared by the companion and the daemon, and
`lib/finish.mjs` (merge + read + replay + open/notify) by `session` and the
daemon.

Fixture baselines, re-run green after every refactor this sitting: `lab-run`
5/5, `check` 4/5 (fifth honestly UNFALSIFIABLE), `score out/session7` 4/4 with
deepgram.

## The hard-won platform facts (do not relearn these)

- **The browser cannot own the microphone on macOS.** TCC never attributes a
  capturer inside Chrome's process tree: no prompt, zeroed buffers, confirmed
  live twice (aa15119). Voice must be a process the user launched — the
  companion, or now the daemon. Do not try to make the extension record audio.
- **A signed .app bundle with NSMicrophoneUsageDescription gets the grant** a
  bare node binary cannot (26729da). `lib/mac/rewalk-mic.app`, source in
  `lib/mac/rewalk-mic-src/`. AND: **a child bundle does not carry its own TCC
  responsibility — it rolls up to the launchd job** (measured this sitting: a
  bare-node LaunchAgent gets digital silence from the very bundle that records
  real audio via LaunchServices). The daemon's LaunchAgent therefore points at
  `lib/mac/rewalk-voiced.app`, a signed wrapper that spawns node as a child
  (spawn, not exec) so the whole tree answers as com.rewalk.voiced. With the
  wrapper, the launchd startup audition passes: `daemon up; mic auditioned ok`.
- **Chrome and launchd spawn processes with a minimal PATH.** No node
  (7a8ee7f — wrappers bake the absolute path), no ffmpeg/terminal-notifier
  (3b5fb05 — host and daemon prepend Homebrew before importing anything that
  shells out). Symptom: avfoundation "lists no devices" while CoreAudio names
  a default.
- **The stop signal is the host's finalized session.json** (`via:
  'extension'`, mtime-guarded). The stop click closes the native port, the
  host's last act is that write, and both the companion and the daemon watch
  for it. The STOP file remains the manual fallback everywhere.
- **rrweb needs the MAIN world**, and Plasmo's dynamic MAIN-world registration
  races the first navigation silently (ext/PROBE-RESULTS.md). Production uses
  on-demand `registerContentScripts` + confirm + reload (5869a6e).
- **CDP attach to the default profile is dead** since Chrome 136
  (notes/extension-route.md). Never offer it as a workaround.
- **Deepgram live segmentation is the good path** (12.5% vs 42.5% WER;
  587405d). Recipe in `lib/dg-stream.mjs`. Key: `~/.config/rewalk/deepgram.key`
  (0600), read at point of use, never in env. Streamed sessions carry
  `utterances.ndjson`; nothing downstream re-transcribes them.
- **Verify replays by pixels, never node counts** (2467a1a). Same doctrine for
  video: frame-step (`goto(t)` per frame) instead of screencasting, so A/V
  alignment is arithmetic, not pre-roll archaeology.
- **`el.id` on a form is not a string** when a field is named `id` (39ce3a6).
  Rects are sampled in layout coordinates; the "two coordinate frames"
  doctrine in older docs was wrong.
- **Audio capture drops 10–18% of samples without `aresample=async=1`**
  (305daa8). Fixed in both ffmpeg paths; the Swift bundle verified at 0 loss.
- The audition gate (`classifyAudition`) runs in every capture path;
  0.000000 = permission denial. The daemon auditions ONCE at startup so
  per-session starts lose no words to the 3s gate; a failed startup audition
  degrades to per-session gating rather than dying (KeepAlive would
  relaunch-loop against the device). The HUD level meter reads bytes on disk —
  now including the daemon's wav growing in the host's dir — so it cannot lie.
- The acoustic beacon remains untested, not failed (55b778e). Nothing depends
  on it.

## File map (what changed this sitting marked •)

```
rewalk/
  bin/session.mjs        one command; finish logic now in lib/finish.mjs •
  bin/daemon.mjs         • voice at login: polls out/.rewalk-voice, records, finishes, notifies
  bin/stream-audio.mjs   voice companion; live path moved to lib/voice.mjs •
  bin/video.mjs          • replay → mp4 (frame-stepped, wav muxed on wall clock)
  bin/walkthrough.mjs    • per-click study artifact for third-party sites
  bin/read|replay.mjs    now share loadUtterances; replay.html gains __rewalk handle + #t= seeks •
  bin/watch|locate|score|stt-compare|mic-check|lab-run|check|align-test|beacon-smoke.mjs
  lib/voice.mjs          • recordVoice + writeVoiceArtifacts + hostFinalized (companion & daemon)
  lib/finish.mjs         • merge + read + replay + open/notify (session & daemon)
  lib/utterances.mjs     + loadUtterances (streamed-first, one loader for all readers) •
  lib/record.mjs, lib/tick.js|motion.js|hud.js, lib/mic.mjs, lib/mac/*, lib/dg-stream.mjs,
  lib/audio-device.mjs, lib/serve.mjs   as before
  daemon/                • install.sh/uninstall.sh (LaunchAgent com.rewalk.voiced) + README
                           with the TCC-under-launchd caveat spelled out
  chrome-ext/            host now writes/retires out/.rewalk-voice; HUD falls back to
                           the daemon's wav; README documents the no-command flow •
  out/                   session5 + session7 scored baselines; ledger-01 the real-app session;
                           *-i2-* are eval-iteration-2 stripped copies (disposable)
rewalk-skill/            updated to the button-era surface and INSTALLED (symlink
                           ~/.claude/skills/rewalk → this dir) •
```

## The skill and its evals

`rewalk-skill/` now teaches both capture routes, the button stop, the daemon,
video and walkthrough; `references/session-artifacts.md` covers
utterances.ndjson/audio-meta.json and the via:'extension' stop-signal role.
Installed as a symlink at `~/.claude/skills/rewalk` after eval iteration 2.

Iteration 2 (`~/.claude/skills/rewalk-workspace/iteration-2/`, 6 runs,
grade.py, benchmark.json): stripped per-run session copies removed the
iteration-1 leak, and the result is honest — **11/11 with skill, 11/11
baseline**. The repo documents itself well enough that baseline agents recover
the whole procedure from README + tool stdout. The skill's visible value is
procedural discipline (deepgram by default, pixel doctrine, disk-verification
language) and triggering on first contact, not outcome deltas on healthy
sessions. To make an eval discriminate, the session must carry a failure-mode
trap where `references/sharp-edges.md` decides the outcome: a clock with real
dropRate, a stream missing its Meta event, a digitally-silent wav. That is
iteration 3, if the skill work continues. Also measured: unattended agents
cost 10–15s per OS-level click round trip — an eval that says "about 15
seconds" will overshoot ~6x through no fault of the recorder.

## Roadmap, ranked

1. **Live paired human run.** Still the top gap: no human has talked+clicked
   through a paired recording in one take. The daemon is installed and its
   launchd mic audition passes, so the cheapest form is now the button alone:
   click, talk, click, notification. First real run closes it.
2. **A real "learn a feature" session** — the openlogi recording was
   speechless; record one narrated pass over a third-party feature and judge
   walkthrough.md against what a study doc should be.
3. Skill eval iteration 3 with failure-mode traps (see above), only if the
   skill work continues.
4. Standing honest flags: beacon acoustic path untested; `motion-settles`
   UNFALSIFIABLE; `bin/check.mjs` still not folded into the runners.

## Setup on a fresh sitting (or machine)

1. `cd rewalk && npm install` (postinstall descends into skill/). Fixture
   server self-binds.
2. Rebuild derived artifacts if lib changed: `node chrome-ext/build.mjs`;
   rebuild rewalk-mic.app per `lib/mac/rewalk-mic-src/README.md`.
3. Human steps, run knowingly: `sh chrome-ext/host/install.sh` + Load unpacked
   (`chrome-ext/`, pinned id in `host/.ext_id`); optionally
   `sh daemon/install.sh` for the button-only flow.
4. Mic sanity: `node bin/mic-check.mjs 5`. 0.000000 = permission; device
   indices shift — never hardcode.
5. Regression: `node bin/lab-run.mjs` (5/5), `node bin/check.mjs` (4/5),
   `REWALK_STT=deepgram node bin/score.mjs out/session7` (4/4).

Env vars: `REWALK_STT`, `REWALK_SEGMENT`, `REWALK_MODELS`,
`REWALK_SKIP_AUDITION`, `REWALK_UNMASK`, `REWALK_HOST_MIC`, `REWALK_PORT`,
`REWALK_DEEPGRAM_KEY_FILE`, `REWALK_NO_OPEN` (suppress auto-open, for tests).

## History access

Every working session on this machine is searchable: `sxr grep -c "<topic>"`
from the repo dir. This sitting's narrative — the stop-signal design, the
daemon's file-not-socket decision, the frame-stepping rationale, the eval
iteration 2 spawn protocol (six parallel Agent runs, prompts in the
transcript) — is all in the transcripts.

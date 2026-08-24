# rewalk — handoff, 2026-08-24

Written at 26 commits past the previous handoff (f91b58c has the old one; its
seven open items are all closed or superseded). Tree clean except `rewalk-skill/`,
committed with this document. Every claim below was measured in this session;
where something is untested it says so.

## What this is for

Record a person using any web UI — DOM stream, their voice, alt-click pointing —
then: save a replay you can watch, resolve what they SAID to what the DOM DID,
and hand a coding agent the metadata (ranked deltas + candidate source files) so
it fixes the bug precisely instead of being told a story about it.

Two use cases drive the roadmap:
1. **Fix frontend bugs precisely** — record yourself hitting the bug in your own
   app, agent gets `resolved.json` + `located.json` + the replay.
2. **Learn how a feature is built on someone else's site** — record yourself
   using the feature in your real logged-in Chrome; the DOM stream + replay is
   the study material. (`locate` needs source on disk, so on third-party sites
   the output is diagnosis, not a fix site.)

## State: what works, with evidence

Three recording routes, one session format. `read`/`replay`/`locate`/`score`
do not know which route recorded a session.

| route | what | proven |
|---|---|---|
| `rewalk watch <url>` | CLI: Playwright Chromium + inline mic (ffmpeg) | 4/4 top-1 on real speech twice (session5, session7); 0.00% sample loss since the aresample fix |
| chrome-ext (button) | DOM in the user's REAL Chrome profile, on demand, one tab | 553 events captured from openlogi.org, live third-party site, default profile |
| `rewalk session` | one command: streaming voice companion + extension DOM co-located in one dir, merged, auto-read | end-to-end with `--from-wav`: 102 DOM events co-located via the `out/.rewalk-current` pointer, 6 streamed utterances, stasis query resolved on the merged session |

The analysis chain: `read` (whisper batch, deepgram batch, or pre-streamed
deepgram-live utterances) → `replay.html` (self-contained player, complaints on
the timeline, click seeks to 2.5s before the words) → `locate <session> <repo>`
(selector tokens → source files; skeleton.tsx and transaction-drawer.tsx found
correctly from unscripted speech on the ledger app).

Fixture baselines that must stay green: `lab-run` 5/5, `check` 4/5 (fifth
honestly UNFALSIFIABLE), `score out/session5` 4/4, `score out/session7` 4/4
with deepgram.

## The hard-won platform facts (do not relearn these)

Each cost real time this session. Pointers go to the commit or file with the
full story.

- **The browser cannot own the microphone on macOS.** A capturer anywhere in
  Chrome's process tree is never attributed to our bundle by TCC: no prompt,
  zeroed buffers. Confirmed live twice (aa15119). Voice must be a process the
  user launches — that is why the companion exists, and why `session` is shaped
  the way it is. Do not try to make the extension record audio again.
- **A signed .app bundle with NSMicrophoneUsageDescription gets the grant** a
  bare node binary cannot (26729da). `lib/mac/rewalk-mic.app`, source in
  `lib/mac/rewalk-mic-src/`, build commands in its README. Pattern from
  `~/src/tries/2026-03-16-aemal-vibestage-desktop` (CopilotAudio.app), pared to
  mic-only so no Screen Recording permission.
- **Chrome spawns native hosts with a minimal PATH.** No node (7a8ee7f — the
  wrapper bakes in the absolute path), and no ffmpeg (3b5fb05 — the host
  prepends Homebrew etc. before importing anything that shells out). Symptom of
  the second: avfoundation "lists no devices" while CoreAudio names a default.
- **rrweb needs the MAIN world**, and Plasmo's dynamic MAIN-world registration
  races the first navigation, silently (ext/PROBE-RESULTS.md). The production
  extension uses on-demand `registerContentScripts` + confirm + reload — the
  pattern the probe measured at 5/5 (5869a6e).
- **CDP attach to the default profile is dead** since Chrome 136
  (notes/extension-route.md). Never offer it as a workaround.
- **Deepgram live segmentation is the good path.** Server-side
  `utterance_end_ms`/`endpointing` boundaries beat energy VAD (12.5% vs 42.5%
  WER when the speaker runs complaints together; 587405d). The streaming
  recipe (nova-3, linear16/16k, KeepAlive, binaryType=arraybuffer) is in
  `lib/dg-stream.mjs`, reused from the vibestage project. Deepgram key:
  `~/.config/rewalk/deepgram.key` (0600), read at point of use, never in env.
- **Verify replays by pixels, never node counts.** A structurally perfect
  1171-node replay rendered blank because slicing to the FullSnapshot dropped
  the Meta event carrying the viewport (2467a1a).
- **`el.id` on a form is not a string** when a field is named `id`
  (39ce3a6). Rects are sampled in layout coordinates now — the "two coordinate
  frames" doctrine in older docs was wrong and scroll-flooded the ranking on
  the first real scrolling page.
- **Audio capture drops 10–18% of samples without `aresample=async=1`**, and
  ffmpeg's out_time hides it (305daa8). Fixed in both ffmpeg paths; the Swift
  bundle does its own conversion and was verified at 0 loss.
- The audition gate (loud-AND-flat refusal, 0.000000 = permission denial) runs
  in every capture path via `classifyAudition` in `lib/mic.mjs`. The HUD's
  level meter reads bytes already on disk, so it cannot lie about a dead
  device (d722628).
- The acoustic beacon was never heard because output was on headphones —
  untested, not failed (55b778e). Nothing depends on it; its only remaining
  job is measuring the progress clock's intercept bias.

## File map (what to read before touching what)

```
rewalk/
  bin/session.mjs        ONE command: companion + extension co-location + merge + read
  bin/stream-audio.mjs   voice companion, live Deepgram; --from-wav test mode
  bin/record-audio.mjs   voice companion, batch (no streaming)
  bin/sync.mjs           manual join of separate DOM + audio dirs (session makes this unnecessary)
  bin/watch|read|replay|locate|score|stt-compare|mic-check|lab-run|check|align-test|beacon-smoke.mjs
  lib/record.mjs         bootScript (transport: 'binding'|'event'), Sink, startMic, fitProgressClock
  lib/tick.js|motion.js|hud.js   injected instruments — SHARED by CLI and extension (build.mjs derives)
  lib/mic.mjs            ffmpeg Mic + auditionMic + classifyAudition
  lib/mac/bundle-mic.mjs BundleMic (drop-in for Mic, spawns the signed bundle)
  lib/mac/rewalk-mic-src/ + rewalk-mic.app   the TCC-clearing capturer (app gitignored, rebuild per README)
  lib/dg-stream.mjs      Deepgram live WebSocket helper
  lib/audio-device.mjs   CoreAudio default-input + avfoundation mapping (never index-hardcode)
  lib/serve.mjs          fixture server, self-binding, reuses an existing one
  chrome-ext/            manifest (on-demand, pinned key), src/sw.js, src/relay.iso.js,
                         build.mjs -> src/boot.main.js (generated, gitignored),
                         host/rewalk-host.mjs + install.sh (HUMAN runs it) + README (the recipe)
  ext/PROBE-RESULTS.md   MAIN-world ordering probe (Plasmo race finding)
  ext-probes/native-host/ throughput (233x headroom) + TCC probe scripts
  notes/extension-route.md   the decision memo (route A vs B, all citations)
  fixtures/hypothesis.html   teleprompted, self-scoring fixture (ground truth for score)
  out/                   sessions; session5 + session7 are the scored real-speech baselines
FINDINGS.md              the pre-extension findings (join, clock, capture bugs)
rewalk-skill/            the drafted Claude skill (see below)
```

## The skill and its evals

`rewalk-skill/` is a complete Claude Code skill (SKILL.md + references/
sharp-edges.md + session-artifacts.md + evals/). It was developed at
`~/.claude/skills/rewalk` and MOVED here so baseline eval agents couldn't see
it. **To use it, copy/symlink it back to `~/.claude/skills/rewalk`.** Its
SKILL.md predates `rewalk session` — update the procedure section before
reinstalling.

Eval iteration 1 lives at `~/.claude/skills/rewalk-workspace/iteration-1/`
(6 runs, grading.json, benchmark.json). Result: 11/11 with skill vs 10/11
baseline; the honest notes in benchmark.json matter more than the score — the
clean discriminator was pixel-verification of replays; eval-1 didn't
discriminate because the session dir contained precomputed analysis (strip
derived artifacts for iteration 2). A viewer server may still be running
(`pkill -f generate_review.py`). User feedback was never submitted.

## Toward seamless: the agreed UX and the ranked work

The current flow (terminal command + Chrome button + `touch STOP`) was judged
bad UX, correctly. The agreed ideal: **the toolbar button is the whole
interface** — click to start (HUD shows live mic state), click to stop, macOS
notification opens the replay. The mic constraint is dissolved by a menu-bar
agent launched at login that holds the grant and takes start/stop over a local
socket from the extension host.

1. **Cheap stop fix (~20 lines, do first):** the button click already closes
   the host's native port; make `session`/companion treat that as STOP (watch
   for host finalization in the shared dir) so the terminal is only touched
   once per sitting. Then auto-open replay.html on finish.
2. **Menu-bar daemon:** LaunchAgent wrapping BundleMic + dg-stream + the
   session-dir protocol. Pure packaging; every piece is proven. This deletes
   the terminal entirely.
3. **Replay as video:** the user wants shareable videos of sessions.
   replay.html is an interactive player; an mp4 export is: drive replay.html
   in Playwright, screencast/record, mux the session wav on the wall-clock
   offset. All ingredients exist in-repo. Nothing built.
4. **Live paired human run:** every piece is proven separately; no human has
   yet talked + clicked through `rewalk session` in one take. First real run
   closes it.
5. **"Learn a feature" mode:** for third-party sites, `locate` is moot; what's
   wanted is a narrated walkthrough artifact (replay + utterances + the DOM
   regions that changed per step). The reading machinery already produces the
   parts; design the output.
6. Skill eval iteration 2 (stripped-session eval-1), then reinstall the skill.
7. Standing honest flags: beacon acoustic path untested; `motion-settles`
   UNFALSIFIABLE; `bin/check.mjs` still not folded into the runners.

## Setup on a fresh sitting (or machine)

1. `cd rewalk/skill && npm install` (Playwright etc.). Fixture server
   self-binds; nothing else to start.
2. Rebuild derived artifacts if lib changed: `node chrome-ext/build.mjs`
   (boot.main.js); rebuild rewalk-mic.app per `lib/mac/rewalk-mic-src/README.md`.
3. Native host install is a HUMAN step (the safety classifier rightly blocks
   agents): `sh chrome-ext/host/install.sh`, then chrome://extensions → Load
   unpacked → `chrome-ext/`. Pinned ext id must match
   `chrome-ext/host/.ext_id`.
4. Mic sanity: `node bin/mic-check.mjs 5`. Remember 0.000000 = permission, and
   device indices shift — never hardcode.
5. Regression: `node bin/lab-run.mjs` (5/5), `node bin/check.mjs` (4/5),
   `REWALK_STT=deepgram node bin/score.mjs out/session7` (4/4).

Env vars: `REWALK_STT`, `REWALK_SEGMENT`, `REWALK_MODELS` (stt-compare sweep),
`REWALK_SKIP_AUDITION`, `REWALK_UNMASK`, `REWALK_HOST_MIC`, `REWALK_PORT`,
`REWALK_DEEPGRAM_KEY_FILE`.

## History access

Every working session on this machine is searchable: `sxr grep -c "<topic>"`
from the repo dir. This session's full narrative — including the dead ends not
written up here — is in the transcripts. The Plasmo probe, the eval harness
design, and the TCC investigation all have more detail there than any doc.

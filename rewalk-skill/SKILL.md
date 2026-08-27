---
name: rewalk
description: Record a person using a web UI — DOM stream, voice, and alt-click pointing — then resolve what they SAID to what the DOM DID, play the session back, and map complaints to source files. Use this whenever the user wants a session replay, wants to record themselves (or someone) using a site or app, says "watch me use it", "start a replay session", "record a QA session", or wants to inspect how a page behaves. Also reach for it when debugging starts from a spoken-style UI complaint — "it jumps around", "it never scrolls into view", "it's flaky", "the card doesn't follow" — even if nobody says the word "replay": rewalk turns exactly that kind of vague complaint into a ranked list of DOM changes and candidate source files. Also use it to study how another site's UI is built ("what component is this", "how do they do this"): on React apps every click and ⌥-point records the component it landed on, with the names that survive minification and the prop keys.
---

# rewalk

rewalk records a human using a web page: an rrweb DOM stream, their voice from
the microphone, and alt-click marks for pointing. On React pages each mark
also carries the component it landed on, walked from the fiber live at click
time: `react: { chain, anon, props }` — authored names innermost-first, a
count of minified composites, and the prop keys (never values) of the
innermost named client component. It then segments the speech,
resolves each utterance to the DOM changes it was about (rarity beats
magnitude; stasis is a separate query), builds a playable replay with the
complaints on the timeline, and — when the app's source is on disk — maps each
complaint to the files that render the thing complained about. The chain is:
record → read → replay → locate, with two share/study artifacts off the side:
`video` (mp4 of the replay) and `walkthrough` (per-click study notes for
sites whose source is not on disk).

## Where it lives

After `sh install.sh` from the repo root, the CLI is `rewalk` on PATH (shim
in `~/.local/bin`). From a checkout, run every command from `rewalk/` as
`node bin/<verb>.mjs`. Nothing needs starting by hand — the fixture server
binds itself if a target URL is not supplied.

| verb | what it does |
|---|---|
| `node bin/doctor.mjs` | verify the install chain (deps, bundle freshness, signing, native host, config); every failure names its fix. Run when anything misbehaves |
| `node bin/mic-check.mjs [secs]` | is the microphone hearing a person? Run this FIRST |
| `node bin/session.mjs <outDir>` | record in the user's REAL Chrome: voice companion + extension DOM in one dir; the toolbar button starts and stops it, then the replay opens itself |
| `node bin/watch.mjs <url> <outDir>` | record in a fresh Playwright Chromium (no extension, no logins). The URL is the app under test — the self-binding server only covers the bundled fixtures |
| `node bin/read.mjs <outDir>` | resolve each utterance to ranked DOM deltas (uses streamed utterances when the session has them, transcribes otherwise) |
| `node bin/replay.mjs <outDir>` | build a self-contained replay.html, complaints on the timeline |
| `node bin/video.mjs <outDir>` | export the replay as a shareable mp4, session audio muxed on the wall clock |
| `node bin/share.mjs <outDir>` | copy video + replay.html + resolved/located/session.json to the configured dest |
| `node bin/walkthrough.mjs <outDir>` | study artifact for third-party sites: one section per click with its component, speech and changed DOM regions inside each step, and a closing "Components touched" index |
| `node bin/locate.mjs <outDir> <repo>` | map resolved complaints to the source files that render them |
| `node bin/score.mjs <outDir>` | scored accuracy — fixture sessions ONLY (see limits) |
| `node bin/comment.mjs --sessions` | which agent sessions a browser comment could be sent to |
| `node bin/hub.mjs status` | the comment queue and who is live |

With the voice daemon installed (`sh daemon/install.sh`, a human step), no
command is needed at all: the Chrome toolbar button starts a paired recording,
clicking it again stops everything, and a notification opens the replay.

`REWALK_STT=deepgram` before `read`, `replay`, or `score` switches
transcription from local whisper to Deepgram (key read from
`~/.config/rewalk/deepgram.key` at the moment of use; it is not put in the
environment where child processes would inherit it).

## Running a session

**1. Gate the microphone before anything else.**

```
node bin/mic-check.mjs 6
```

Talk for six seconds. `READY` means go. A peak of exactly `0.000000` means
macOS is denying microphone access to the terminal (System Settings > Privacy
& Security > Microphone) — macOS hands out zeroed buffers instead of failing,
so frames arriving proves nothing; only a non-zero sample does. The check
measures dynamics, not level: a fan and a talker can share an RMS, but speech
has gaps between phrases and a fan does not.

`watch` runs this gate again internally (`auditionMic`) and refuses a session
whose audio is loud AND flat — that signature cost two real sessions, both
transcribed as `[Music]` end to end. `REWALK_SKIP_AUDITION=1` overrides, but
say why before using it.

**2. Pick the route, start the recorder in the background.**

For the user's real Chrome (their logins, their profile) — requires the
extension + native host installed once (`sh chrome-ext/host/install.sh`, a
human step):

```
node bin/session.mjs out/session-01   # run_in_background
```

Tell the user: click the rewalk toolbar button and choose **Record this tab
with voice**, use the page and talk, then click the button again and choose
**Stop and finish**. That second choice ends everything — the session merges,
reads itself back, and replay.html opens. The terminal is never touched again.

The popup's other two choices matter for what you are being asked to do:
**Record this tab, DOM only** never asks for the microphone (a replay and
source mapping need the DOM stream and nothing else), and **Comment on this
page** records nothing at all. If the user does not intend to narrate, say so
and pick DOM only — a microphone that turns on because someone wanted a replay
is the wrong thing to do to them, and `mic-check` becomes irrelevant.

For a fresh Playwright Chromium (fixtures, localhost, anything the user can
log into during the session — zero setup):

```
node bin/watch.mjs http://localhost:3000/ out/session-01   # run_in_background
```

Wait for `stop with: touch out/session-01/STOP` in its output, then bring the
"Google Chrome for Testing" window to the front for the user
(`osascript -e 'tell application "Google Chrome for Testing" to activate'`).
The first click may need to land before anything else happens, and a session
with zero clicks records audio nobody can attach to anything.

**3. Trust the HUD, and coach the user with exactly three rules.**

A small strip in the corner of the recorded window shows the mic state. Green
"hearing you" means the bytes on disk contain their voice — the level is
computed by the host from the recording itself, so it cannot show a healthy
level over a dead device. Red means "mic hears nothing" or "recorder not
reporting"; stop and fix before letting them continue.

Tell the user:

1. **Talk after you act, not before.** Click, watch what happens, then say
   what was wrong. The join searches a window around each utterance and
   expects narration to lag the interaction by a second or two — which is
   where people naturally speak anyway.
2. **Pause about half a second between separate complaints.** The segmenter
   cuts on silence. Two complaints run together become one region, and one of
   them loses its text entirely — measured: a merged pair cost a complaint its
   whole transcript and mis-paired the next one.
3. **⌥-click (alt-click) the thing you mean** while talking about it. A
   hairline ring follows the pointer showing exactly what a click will mark —
   amber while ⌥ is held, a green flash when the point lands — with a chip
   naming the component when the page is React. The mark carries its ancestor
   chain, so pointing at a table row credits the container three levels up
   that failed to scroll. The HUD flashes "✓ pointed at …" when a mark lands.

**4. Stop cleanly.**

`session` route: the user clicks the rewalk button again — that is the whole
stop. `watch` route (and the fallback for a session whose button was never
clicked):

```
touch out/session-01/STOP
```

The stream is append-only throughout; a crash costs at most the last 250ms.
Inputs are masked by default — passwords record as dots. `REWALK_UNMASK=1`
records keystrokes in the clear and announces itself on stdout; only use it
when the typed values are the point.

## Reading a session back

Prefer Deepgram:

```
REWALK_STT=deepgram node bin/read.mjs out/session-01
```

Deepgram's word-level timings segment better than energy-based cutting when a
speaker runs complaints together — measured on the same recording: 12.5% word
error rate against 42.5% for whisper, and the join went 4/4 against 3/4.
Whisper stays the default because it needs no key and no network; it is fine
when the speaker pauses between complaints.

A session recorded through `session` or the daemon already streamed its
speech live (utterances.ndjson, Deepgram's server-side boundaries); `read`,
`replay` and `walkthrough` all prefer that file automatically — no
`REWALK_STT` needed and no second transcription pass happens.

Then build the replay:

```
REWALK_STT=deepgram node bin/replay.mjs out/session-01
open out/session-01/replay.html
```

Verify the replay by looking at it — open it, screenshot it, confirm the app's
UI is visible. Never verify by counting DOM nodes: a replay once rendered a
blank white rectangle while containing 1,171 correctly-built nodes, because a
dropped Meta event lost the viewport. Node count is not pixels.

If the app's source is on this machine:

```
node bin/locate.mjs out/session-01 /path/to/the/app/repo
```

This greps the repo for the authored tokens in each top delta's selector
(aria-labels and testids weighted highest, generated utility classes ignored,
test files at 0.4x) and prints candidate files with the token and line that
found them. It is probabilistic and says so: a miss reports "no source
located" rather than the nearest-scoring wrong file.

## When a comment arrives from someone's browser

A `<rewalk-comment id="rwc-N">` block appearing in your context is not
something you asked for. A person pressed ⌘⇧U in Chrome, clicked the elements
they were talking about, typed a sentence and chose this session. They are
looking at their browser, not at this terminal.

The block carries the comment, the page URL, and one `node:` line per selected
element — a selector, its visible text, and on React pages the component chain
and prop keys. Anchoring degrades honestly: a selector and a snippet are all
that exist when nothing was being recorded, so do not assume a node still
matches after a re-render.

A node marked `[inside iframe <url>]` was selected in a child frame — a
Storybook story, a docs preview. Its selector resolves in THAT document, not
the page's, and the iframe's URL is usually the more useful thing to open.

**Act on it in the turn it arrives.** It was queued while you were working and
it is about the thing the person is looking at now.

When the block names a `session:` directory, that is a rewalk recording of the
moment the comment was written, and it is the difference between a sentence and
evidence. Run the commands it lists, in order:

1. `rewalk read <dir>` — only if `resolved.json` is missing. Finishing may still
   be running when the comment reaches you; the recording itself is complete.
2. `rewalk replay <dir>` — `replay.html`, with the complaint on the timeline.
3. `rewalk locate <dir> <repo>` — the source files that render the node, when
   the app's source is on this machine.

Then diagnose from `resolved.json` (the ranked DOM deltas around what was said)
plus the comment's own selectors, which are ground truth: the person pointed at
those, the resolver did not have to infer them. Fix, and say what you changed.

With no session directory, work from the selector, the snippet and the
component chain alone, and say plainly that you are working without a
recording — the person can record one with the toolbar button if the anchor
turns out to be wrong.

Never reply to a comment by writing in this terminal alone and calling it done.
There is no reply path back to the browser yet, so the honest close is to say
what you changed and let the person see it in the app.

## Honest limits

State these to the user rather than letting them be discovered:

- **No score on real sites.** `score` only works on the teleprompter fixture,
  where ground truth is stamped into the recording. On a real site the output
  is a ranked list per complaint, and whether it named the right thing is the
  user's judgement — that judgement is the experiment.
- **Third-party sites can be diagnosed but not fixed.** No source on disk
  means `locate` has nothing to search and there is nothing to edit. The loop
  only closes on an app whose repo is on this machine. What a third-party
  recording is for is study — `walkthrough` turns it into that artifact.
- **On production React the component names mostly minify away.** What
  survives is library displayNames and the prop keys, which is usually enough
  to study a component's contract (measured on Linear: the sidebar item's
  name died, its props — to, additionalActions, trailingActions,
  setIsMenuOpen — told the story). `anon` counts what the minifier hid, so
  "React but unnamed" is distinguishable from "not React".
- **Two capture routes; pick by whether the user needs their real profile.**
  A fresh Playwright Chromium (`bin/watch.mjs`): no logins, no history, zero
  setup — right for fixtures, localhost apps, and anything the user can log
  into during the session. The user's real day-to-day Chrome: `bin/session.mjs`
  plus the `chrome-ext/` MV3 extension, whose native host writes the identical
  session format, so read/replay/locate/score do not care which route recorded
  it. The extension route needs `chrome-ext/host/install.sh` run once by a
  person knowingly (it lets Chrome start a recording process); voice comes
  from a separate companion or the login daemon because macOS never grants the
  browser the microphone. Never offer CDP attach as a workaround — Chrome
  136+ blocks it for the default profile.
- **Evidence base is thin.** The join scored 4/4 twice on a fixture whose bugs
  are known by construction, and correctly located source files from one real
  uncontrolled session. That the whole loop speeds up debugging is the
  untested hypothesis; do not oversell it.

## References

- Read `references/sharp-edges.md` before diagnosing any failure — recorder
  silent, empty transcript, blank replay, flat audio. Most failures here have
  been hit before, measured, and have a known cause.
- Read `references/session-artifacts.md` when consuming a session
  programmatically — what each file in an `out/<session>/` directory contains
  and which fields downstream tools rely on.

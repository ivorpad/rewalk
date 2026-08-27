# rewalk chrome-ext — record your real profile

Records the page you are actually on, in your day-to-day Chrome, into a rewalk
session that `read`/`replay`/`locate`/`score` consume unchanged. This is the
route the decision memo chose (`../notes/extension-route.md`) after CDP attach
was ruled out — Chrome 136 blocks `--remote-debugging-port` on the default
profile.

## How it fits together

Nothing is injected into any page until you ask. The toolbar button opens a
popup with the three things it can do, because the two real decisions here were
invisible when one click did everything: whether to record at all, and whether
to record **voice**.

| popup choice | what happens |
|---|---|
| Comment on this page | overlay only — no recording, no reload, no microphone |
| Record this tab, DOM only | replay + source mapping, and **no microphone is asked for** |
| Record this tab with voice | as above, and the daemon (or the companion) records voice |

While recording, the popup offers **Stop and finish** and **Comment, then
stop** — sending a comment ends the recording, so the comment arrives with a
replay behind it.

Voice is a request the host writes for the daemon (`out/.rewalk-voice`), and
"DOM only" simply does not write it. `record.voice: false` in
`~/.config/rewalk/config.json` makes DOM-only the default for every route; the
popup and the context menu still override it per session. `session.json`
records which was chosen, so a reader can tell "nobody spoke" from "voice was
never asked for".

Idle, the extension touches no page — it is a recorder you start, not a logger
that watches everything.

```
popup "Record" ─► service worker  src/sw.js   registers scripts for THIS tab,
                                              reloads it, binds it, stops on ask
                     │ registerContentScripts (MAIN + ISOLATED, document_start)
                     ▼
page (MAIN world)    src/boot.main.js   rrweb + tick + motion + hud, generated
   │  CustomEvent                        from ../lib by build.mjs — same
   ▼                                      instruments the CLI injects
relay (ISOLATED)     src/relay.iso.js   the only side that can reach chrome.runtime
   │  Port
   ▼
service worker       src/sw.js          bridges the tab's batches to the host
   │  connectNative (4-byte LE + JSON)
   ▼
native host          host/rewalk-host.mjs   watch.mjs minus Playwright:
                                            Sink + Mic + clock, writes out/ext-*
```

Comments are the second, independent job, and they run on any page whether or
not a recording is going:

```
popup "Comment" (or ⌘⇧U, or right-click → "rewalk: comment on this page")
   │ executeScript, ISOLATED, on demand
   ▼
page (ISOLATED)      src/annotate.iso.js   selection rings + panel in a CLOSED
   │  sendMessage                           shadow root; generated from ../lib
   ▼                                        so it shares lib/selector.js with
service worker       src/sw.js              the recorder's marks
   │  connectNative (same port, different meaning)
   ▼
native host          host/rewalk-host.mjs   validates the envelope, forwards it
   │  unix socket /tmp/rw-<user>/hub.sock
   ▼
hub                  bin/hub.mjs            queues it until the chosen agent
                                            session's next hook fires
```

Opening the native port no longer means "a recording is starting" — the host
stays idle until it gets `control:start`, so a comment on a page nobody is
recording costs a pipe and nothing else: no session directory, no voice
request, no microphone.

The overlay is invisible to the recording, and that is not incidental. It lives
in one host element carrying `class="rr-block"` (rrweb skips it) and
`id="rewalk-comment"` (tick.js, deltas.mjs and highlight.js all exclude it by
name), with a closed shadow root so rrweb cannot traverse in even if the class
failed. It draws selection rings as its own absolutely-positioned divs rather
than touching the page's nodes, and it has no CSS transitions or animations
because motion.js discovers work through transition events. While it is open it
tells the MAIN world over a DOM CustomEvent, and tick.js stops recording clicks
as marks — measured: without that, picking two elements to comment on left two
`click` marks for clicks the app never received.

Register-then-reload is deliberate: the probe found that dynamically registering
a MAIN-world script and navigating immediately races, losing the first load
silently. Registering, awaiting confirmation, then reloading scored 5/5. On
demand, the reload IS the session start, so the pattern falls out naturally.

MAIN world is not a preference. rrweb patches `attachShadow`, the CSSOM methods
and input value descriptors, and prototype patches only see calls in their own
world — in ISOLATED, every page-driven CSSOM change and JS-set input value would
vanish from the recording. The probe confirmed it (`../ext/PROBE-RESULTS.md`).

## Build

```
node build.mjs        # regenerates src/boot.main.js from ../lib
```

Run this after any change to lib/tick.js, lib/motion.js, lib/hud.js or the rrweb
bundle, or the extension and the CLI drift.

## Install (the one step to run knowingly)

`host/install.sh` puts the native messaging host manifest into Chrome's config,
which is what lets this extension start a microphone-recording process. Read it
first. Then load the unpacked extension at this directory via `chrome://extensions`
(Developer mode → Load unpacked). The pinned key keeps the id stable, which the
host manifest's `allowed_origins` depends on.

```
sh host/install.sh
# chrome://extensions → Load unpacked → this directory
```

`host/uninstall.sh` removes the host manifest.

## Record — no command at all

With the voice daemon installed (`sh daemon/install.sh`, see daemon/README.md)
the toolbar button is the whole interface: click to start — the host asks the
daemon for voice via out/.rewalk-voice and both halves land in one ext-<ts>
directory — click to stop, and a notification opens the finished replay.

## Record — one command

    node bin/session.mjs out/session-1

This starts the voice companion, then waits. Click the **rewalk** button in
Chrome to record the tab (the extension co-locates its DOM into the same
directory via out/.rewalk-current, so there is no sync step), talk while you
work, ⌥-click what you mean. When done, click the button again — closing the
native port makes the host finalize its session.json in the shared directory,
the companion sees that and stops too, the session merges, reads itself back,
and replay.html opens. The terminal is touched once per sitting; `touch
out/session-1/STOP` remains as a fallback if the button was never clicked.

## Record — the pieces, if you want them separate

macOS will not let the browser own the microphone: a capturer anywhere in
Chrome's process tree is never attributed to our bundle by TCC, so it gets
zeroed buffers and no prompt. So voice is recorded by a separate companion the
user starts, which is its own responsible process and gets a real grant. The
browser records DOM; the companion records voice; they are joined afterward by
wall clock (same machine, same Date.now — no beacon).

1. **Voice** (a terminal): `node bin/record-audio.mjs out/voice-1` — grant the
   mic prompt the first time; talk while you work.
2. **DOM** (Chrome): go to the tab, click the **rewalk** button. It reloads,
   the badge shows **REC**; use the page, ⌥-click what you mean.
3. Stop both: click the button again (or close the tab); `touch out/voice-1/STOP`.
4. **Join**: `node bin/sync.mjs out/ext-<timestamp> out/voice-1 out/session-1`
   — sync warns if the two windows do not overlap.
5. Read it back: `REWALK_STT=deepgram node bin/read.mjs out/session-1`.

Start both around the same time and stop around the same time, so the windows
overlap. The companion can outlast the DOM recording; sync uses the overlap.

## Verified, and not

Proven without Chrome (the seams that could actually break):
- The MAIN-world bundle emits rrweb batches as cross-world CustomEvents — 11
  batches, 103 events, all four rrweb types, every detail a clean JSON string.
- The host turns framed batches on stdin into a session the existing readers
  accept — Meta + FullSnapshot present, 81 deltas, `via: extension`. Throughput
  has ~233× headroom (`../ext-probes`).
- The HUD reverse path (host RMS → SW → relay → page) delivers.

Answered since:
- The live native-messaging hop through real Chrome works — 553 events captured
  from openlogi.org in the default profile.
- A Chrome-spawned host does NOT get the microphone: no prompt, zeroed buffers.
  That is why voice is a separate companion process, not an in-browser capture.

## Scope of v1

One tab — the one active when recording starts. The service worker binds the
first tab and drops others, because the readers assume one FullSnapshot lineage.
Multi-tab is per-tab NDJSON and a session.json listing them: a reader change, not
a transport change.

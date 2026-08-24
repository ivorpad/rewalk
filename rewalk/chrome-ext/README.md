# rewalk chrome-ext — record your real profile

Records the page you are actually on, in your day-to-day Chrome, into a rewalk
session that `read`/`replay`/`locate`/`score` consume unchanged. This is the
route the decision memo chose (`../notes/extension-route.md`) after CDP attach
was ruled out — Chrome 136 blocks `--remote-debugging-port` on the default
profile.

## How it fits together

Nothing is injected into any page until you press the toolbar button. That
click registers the recorder for the current tab and reloads it; a second click
stops. Idle, the extension touches no page — it is a recorder you start, not a
logger that watches everything.

```
toolbar click ─► service worker  src/sw.js   registers scripts for THIS tab,
                                              reloads it, binds it, stops on 2nd click
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

## Record

Go to the tab you want to record, click the **rewalk** toolbar button. The tab
reloads and the badge shows **REC**; use the page and talk, ⌥-click what you
mean. Click the button again (or close the tab) to stop — the host finalizes
`out/ext-<timestamp>/`, which `read`/`replay`/`locate` consume unchanged.

## Verified, and not

Proven without Chrome (the seams that could actually break):
- The MAIN-world bundle emits rrweb batches as cross-world CustomEvents — 11
  batches, 103 events, all four rrweb types, every detail a clean JSON string.
- The host turns framed batches on stdin into a session the existing readers
  accept — Meta + FullSnapshot present, 81 deltas, `via: extension`. Throughput
  has ~233× headroom (`../ext-probes`).
- The HUD reverse path (host RMS → SW → relay → page) delivers.

Unverified, needs real branded Chrome (a person must run it — installing a
mic-recording host is deliberately not something the agent does):
- The live native-messaging hop through Chrome.
- Whether a Chrome-spawned host inherits Chrome's microphone grant or triggers a
  fresh TCC prompt (`../ext-probes/native-host/PROBE-RESULTS.md`, risk 3).

## Scope of v1

One tab — the one active when recording starts. The service worker binds the
first tab and drops others, because the readers assume one FullSnapshot lineage.
Multi-tab is per-tab NDJSON and a session.json listing them: a reader change, not
a transport change.

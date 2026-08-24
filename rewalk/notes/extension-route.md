# Recording in the user's real Chrome: extension vs CDP attach

Decision memo, 2026-08-24. Question: rewalk today launches a fresh Playwright
Chromium. To record the user's day-to-day profile (logins, history), do we build
an MV3 extension (Route A) or attach to real Chrome over CDP (Route B)?

## 1. Verdict

Route A: MV3 extension in the MAIN world plus a native messaging host that IS
the current host loop (Sink + Mic, unchanged ffmpeg pipeline). Route B is dead
against the default profile: since Chrome 136 (announced 2025-03-17),
`--remote-debugging-port` and `--remote-debugging-pipe` are ignored unless
`--user-data-dir` points to a non-standard directory — the stated motivation is
cookie theft, so this will not be walked back. Every workaround (copied profile,
secondary profile, `chrome.debugger`) either isn't the real profile or costs
more than the extension does. The extension route keeps the two properties that
matter — inject-before-page-code and append-to-disk-as-it-arrives — and the
mic pipeline moves over byte-for-byte because the host still runs ffmpeg.

## 2. What survives untouched

Everything downstream of the session directory. `bin/read.mjs` loads
`session.json`, picks the first `audioClocks` entry with `ok: true`, reads that
wav, and reads `events.ndjson` — nothing in deltas/resolve/read/score/locate
knows what produced the files. Confirmed consumers:

- `bin/read.mjs`: `meta.audioClocks` (exits 2 without an ok clock),
  `meta.mic[].startedWall/endedWall` (via `clockOf`'s drop-rate stretch),
  `events.ndjson`.
- `bin/score.mjs`: same two fields via `clockOf`.
- `bin/replay.mjs`: `meta.url` (display only) + `events.ndjson`.
- `lib/utterances.mjs clockOf`: `audioClocks[].{file, startWall, driftPpm}` and
  the matching `mic[]` segment.

So the capture side, wherever it lives, must still produce: `events.ndjson`
(rrweb events, Date.now()-stamped, appended as they arrive), `audio.N.wav`
(16k mono), and `session.json` with `url`, `audioClocks`
(`file/startWall/driftPpm/residualMs/ticks/ok`), and `mic` segments
(`file/startedWall/endedWall/bytes/device`). `micticks.json` is debug-only.
Because the host still runs ffmpeg with `-progress`, the audio clock is the
same measurement it is today — the 418–1879ms capture-latency spread
(FINDINGS.md, six runs) stays absorbed by the fit, and `aresample=async=1`
keeps covering the measured 10.8–18.5% under-delivery.

Also untouched: `lib/mic.mjs` entirely (audition gate, device-follow,
per-segment clocks), `fitProgressClock`, the HUD's honesty design (level
computed host-side from bytes on disk), and `beacon.js` — it already waits for
the first click/keydown because AudioContext created before a gesture starts
`suspended` (Web Audio under autoplay policy since Chrome 71) and it calls
`resume()`. No flag needed, no extension-specific audio constraint: content
scripts play audio under the page's normal autoplay rules.

## 3. What gets replaced

### Route A (recommended)

| Today (Playwright) | Extension replacement |
|---|---|
| `ctx.addInitScript(bootScript(...))` | Static or `chrome.scripting.registerContentScripts` entry: `js: [boot.js]`, `run_at: "document_start"`, `world: "MAIN"` (static `world` key since Chrome 111), `matches` scoped to the session. Docs: document_start runs "before any other DOM is constructed or any other script is run". |
| `exposeBinding('__rewalkEmit')` | Two-hop bridge. MAIN world cannot touch `chrome.runtime`, so a second tiny ISOLATED content script relays: MAIN dispatches a `CustomEvent` with the 250ms batch → ISOLATED relay → `runtime.connect()` Port → service worker → `runtime.connectNative()` Port → host. The page can observe/forge bridge traffic; acceptable for recording your own browsing, worth a comment. |
| host process launched by us | Native messaging host, spawned by Chrome on `connectNative()`, registered in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.rewalk.host.json`. It is `watch.mjs` minus Playwright: `Sink.push()` per batch, `Mic`, `fitProgressClock`, writes `session.json`. Framing is 4-byte native-byte-order length + UTF-8 JSON. Limits: extension→host 64 MiB/message, host→extension 1 MB/message. Measured worst case here: one FullSnapshot line of 271 KB (out/ledger-01, real app) — 240× headroom in the direction that matters; the return path only carries HUD RMS floats and acks. |
| `page.evaluate(__rewalkHudLevel)` | Same value, reverse path: host → SW → relay → MAIN. |
| mic capture | Unchanged. ffmpeg stays host-side. |

Why MAIN world is required, from the bundle this repo actually injects
(`rrweb.umd.min.cjs`): it patches `attachShadow` (to observe new shadow roots),
`insertRule`/`deleteRule`/`setProperty` (CSSOM mutations), `adoptedStyleSheets`,
and input value property descriptors. Prototype patches only see calls made in
the same JS world; in ISOLATED, every page-script-driven CSSOM change, JS-set
input value, and dynamically attached shadow root would vanish from the
recording. tick.js/motion.js/hud.js themselves would run fine in either world
(MutationObserver, getComputedStyle, getBoundingClientRect, offsetParent walks,
CSS.escape, capture-phase listeners all work on the shared DOM) — but they call
`window.rrweb.record.addCustomEvent`, so they live wherever rrweb lives. Ship
the whole `bootScript` bundle as one MAIN-world file.

Service worker lifetime is not a problem: 30s idle timeout, but
`connectNative()` is documented as a strong keepalive ("will keep a service
worker alive"), and the 250ms batch traffic resets the timers regardless
(Chrome 110 made API calls reset timers; Chrome 116 extended keepalives). On
host crash, the SW gets `onDisconnect` and reconnects — the documented pattern —
buffering batches in the meantime.

Durability accounting vs today: today kill -9 of node costs ≤250ms (page
buffer). Extension route: kill -9 of Chrome costs the 250ms MAIN-world buffer
plus whatever is in flight across two ports — same order, still no
write-at-exit anywhere. kill -9 of the host alone costs only in-flight batches;
the SW respawns it. Chrome quit closes the host's stdin; it flushes and exits.

Manifest surface: `permissions: ["scripting", "nativeMessaging"]`,
`host_permissions: ["<all_urls>"]`. Registering content scripts dynamically
only while a session runs keeps the standing footprint at zero. Pin a `key` in
manifest.json so the unpacked extension ID (which `allowed_origins` in the host
manifest must name) stays stable. Sideloaded/unpacked is fine for now; Chrome
Web Store would treat this as collection of "web browsing activity", which its
policy prohibits "except to the extent required for a user-facing feature
described prominently" — a recorder arguably qualifies, but expect the
prominent-disclosure + data-collection-listing requirements to bite before any
store listing. Input masking must stay on by default for the same reason it
already is in `watch.mjs`.

Scope note: an extension sees every tab; the readers assume one stream with one
FullSnapshot lineage. v1 should record exactly one tab (the one active when
recording starts), filtered by tabId at the relay. Multi-tab means per-tab
NDJSON files and a session.json listing them — a design change for the readers,
not part of this decision.

### Route B (rejected, for the record)

The appeal was that nothing changes: `chromium.connectOverCDP()` +
`addInitScript` + `exposeBinding` on the existing context, host code intact —
the same shape as `skill/scripts/cdp-harness.mjs`, which already drives "the
browser the user has on a debugging port". Chrome 136 closed it for the default
data directory. Remaining variants:

- Secondary `--user-data-dir` recording profile: works, is not the real
  profile. Logins re-established once, then diverge. Honest fallback, not the
  goal.
- Copy the default dir to a new path: the 136 blog says a non-standard dir
  "uses a different encryption key meaning Chrome's data is now protected" —
  on Windows that's App-Bound Encryption; whether a macOS copy still decrypts
  cookies via the shared Keychain key is **unverified, test needed** (10
  minutes: copy, launch, check a logged-in site). Even if it works today it is
  exactly the attack the Chrome team said they are closing.
- `chrome.debugger` from an extension: CDP without the flag, real profile,
  `Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding` give the exact
  Playwright semantics. But it is already an extension (so no install-cost win),
  Playwright can't ride it (hand-rolled protocol), it pins a permanent "is
  debugging this browser" banner, and only one debugger may attach per target —
  the user opening DevTools kills the recording. For a tool whose subjects are
  people using web apps, that conflict is disqualifying.

## 4. Top 3 risks, cheapest experiment each

1. **MAIN + document_start ordering.** The docs guarantee document_start runs
   before page scripts, but do not restate it for `world: "MAIN"`, and there
   are community reports of ordering races (iframes, about:blank, dynamic
   registration). If rrweb boots after the page's first script, the snapshot is
   still fine but hooked APIs miss early calls. Experiment (~30 lines): a
   fixture whose first inline script records `!!window.__rr`, loaded top-level,
   in an iframe, and via window.open; run under static and
   `registerContentScripts` registration. Pass = marker present in all cases.
2. **Native messaging throughput/backpressure.** No documented rate limit, but
   nobody documents sustained 250ms NDJSON batches either. Real sessions here
   average ~4.4 KB/s (1.97 MB / 444s, ledger-01) with 271 KB snapshot bursts —
   three orders below any plausible pipe limit, but the SW hop serializes JSON
   twice. Experiment (~20-line host): echo byte counts + arrival times; drive
   with synthetic 1 MB/s of 250ms batches for 5 minutes; watch RTT growth and
   SW memory. Pass = flat RTT, no port disconnects.
3. **macOS mic permission for a Chrome-spawned host.** Today ffmpeg runs under
   the terminal's TCC mic grant (the audition's error message even names it).
   Spawned by Chrome, the responsible process may be Chrome — whose mic
   permission the user probably granted — or the host binary, which macOS may
   prompt for or silently deny (avfoundation then delivers digital silence,
   which the audition gate catches, but at session start). **Unverified, test
   needed**: minimal host that runs `ffmpeg -f avfoundation -i :1 -t 2` on
   connect and reports bytes captured + any TCC prompt observed. Pass = nonzero
   bytes without a new prompt, or a prompt attributed somewhere the user can
   sensibly approve.

Rejected sinks, and why, if native messaging fails experiment 2:

- File System Access + persisted handles (persistent permissions since Chrome
  122): disqualified outright — "changes are not written to disk until the
  stream is closed", which is precisely the write-at-exit design this repo
  exists to never repeat.
- `chrome.storage.local`: key-value semantics, no append, kill-durability of
  its backing store undocumented. Wrong shape.
- OPFS `createSyncAccessHandle` + `flush()` in a dedicated worker under an
  offscreen document (offscreen API since Chrome 109): the only in-browser
  option with a plausible durability story, but files live inside the profile's
  storage partition, so a session is no longer a directory you can point
  `read.mjs` at without an export hop — and the mic still needs a host process
  anyway, so it buys nothing. Fallback only.
- MediaRecorder/getUserMedia in an offscreen document (`USER_MEDIA` reason):
  loses the audition gate, the `aresample` fix, and the progress-tick clock in
  one move — MediaRecorder exposes no equivalent of out_time, so start latency
  (measured 418–1879ms today) becomes unmeasurable again. Plus getUserMedia in
  an offscreen document fails until mic permission is granted from a visible
  extension page opened in a tab. Rejected.

## 5. Sources

- Chrome 136 debugging-switch restriction (published 2025-03-17):
  https://developer.chrome.com/blog/remote-debugging-port
- Native messaging (framing, 64 MiB / 1 MB limits, lifecycle):
  https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- Content scripts (document_start guarantee, isolated worlds):
  https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- `world` key in static declarations (MAIN since Chrome 111):
  https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- SW lifecycle (30s idle, 5min task, Chrome 110/116 changes, connectNative
  keepalive):
  https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Offscreen API (Chrome 109, USER_MEDIA, one document at a time):
  https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Offscreen getUserMedia permission workaround (extension page in a tab):
  https://groups.google.com/a/chromium.org/g/chromium-extensions/c/V09VMCLzvWM
  and https://github.com/GoogleChrome/chrome-extensions-samples/issues/821
- FSA writes land on close():
  https://developer.chrome.com/docs/capabilities/web-apis/file-system-access
- FSA persistent permissions (Chrome 122):
  https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api
- Web Audio autoplay policy (since Chrome 71):
  https://developer.chrome.com/blog/autoplay
- CWS browsing-activity / limited-use policy:
  https://developer.chrome.com/docs/webstore/program-policies/limited-use
- Repo measurements quoted: FINDINGS.md (capture latency 418–1879ms, drop
  10.8–18.5%), README.md (residual 31.89ms / 1750 ticks), out/ledger-01
  (1.97 MB events / 444s, max event line 271 KB).

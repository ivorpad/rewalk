# Extension probe: does Plasmo MAIN + document_start beat the page's first script?

Executes Risk 1 from notes/extension-route.md. Measured 2026-08-24.

Setup: Plasmo 0.90.5, rrweb 2.1.1 (the byte-identical `rrweb.umd.min.cjs` that
`lib/record.mjs` injects, copied to `lib/rrweb.umd.min.js`), Playwright 1.62.1
with its bundled Chromium 151.0.7922.34, headful, fresh persistent profile per
phase, node 26.7.0, pnpm 11.20.0. Fixture: `fixture/probe.html` (+ `child.html`
in an iframe), served over loopback HTTP on 51944. Runner: `run-probe.mjs`.
Raw per-reload data: `probe-runs.json`; captured rrweb events per reload:
`events-<phase>-reload<N>.json`.

Three phases, 5 page loads each:

- **naive** — extension loaded, navigate immediately after browser launch,
  then reload 4×.
- **mitigated** — same, but the first navigation waits until the extension SW
  answers `chrome.scripting.getRegisteredContentScripts()` with both scripts.
- **baseline** — no extension; the SAME two compiled bundles injected with
  `ctx.addInitScript()` in a plain Playwright context. This is today's route,
  measured on the same fixture rather than remembered.

## How Plasmo actually implements `world: "MAIN"` (this changes the question)

`PlasmoCSConfig` accepts `world: "MAIN"` and `run_at: "document_start"`
(plasmohq/docs, framework/content-scripts, verified against plasmo 0.90.5).
But the build does NOT emit static `content_scripts` manifest entries for
them. The built manifest has no `content_scripts` key at all; instead Plasmo
generates a background service worker that calls
`chrome.scripting.registerContentScripts([{runAt: "document_start", world:
"MAIN", allFrames: true, ...}])` on SW startup, and adds
`permissions: ["scripting"]`. So the probe measured the dynamic-registration
path — the exact variant the memo flagged for ordering races — not the static
`world` key (Chrome 111+) the memo's table names. Two consequences measured
below; one more worth knowing: Plasmo's generated registration call ends in
`.catch(e => {})`, so a registration failure is silent.

## Q1: does the content script run before the page's first inline script?

The fixture's first `<head>` script records whether `window.__probeAt` exists
and whether `Element.prototype.attachShadow` carries the probe's marker.

- **naive, reload 1: total miss.** No injection at all — 0 rrweb events, no
  `__probeAt`; the page's first script ran at t=152ms with nothing present.
  The first navigation beat the SW's `registerContentScripts` call. Reproduced
  on both fresh-profile naive launches performed today (2/2).
- **naive, reloads 2–5: 4/4 pass**, top frame and iframe. Registration had
  completed by then (registered scripts persist — `persistAcrossSessions`
  defaults to true).
- **mitigated, reloads 1–5: 5/5 pass**, top frame and iframe. The wait for
  registration took **291ms** after the SW appeared.
- Margins (page-first-script minus probe, performance.now): 0.5–9.6ms.
  Thin, but this is document_start semantics, not a race — the probe's
  `readyState` was "loading" on every injected load, and `__probeAt` was
  always visible to the page's parse-time script.

**Answer: yes, unconditionally — once the scripts are registered.** The one
failure mode is navigating before dynamic registration completes. A rewalk
session start (register, await, then reload the tab) closes it; the mitigated
phase is exactly that pattern. A static `content_scripts` entry with
`world: "MAIN"` would close it structurally, but Plasmo does not emit one.

## Q2: is attachShadow patched before page code can grab it?

Yes on every injected load (naive 4/4 after reload 1, mitigated 5/5): the
page's parse-time grab of `Element.prototype.attachShadow` received the
patched function.

Bound on the claim: patching helps only calls made through the patch. The
fixture also calls attachShadow via a reference grabbed BEFORE any patching
and creates shadow content with it (`shadow-grabbed-text`). That content was
missing from the recording in **all 15 runs — including the 5 Playwright
baseline runs**. rrweb installs its own attachShadow wrapper only at
`record()` time, which the boot defers to DOMContentLoaded, so a parse-time
grab bypasses it under addInitScript too. Pre-existing limitation of the
current route, not an extension regression.

## Q3: does rrweb capture the three mutation classes in the MAIN world?

The second content script imports the real rrweb 2.1.1 bundle and runs the
`bootScript()` rec boot (record at DOMContentLoaded, emit → window buffer,
maskAllInputs off so the value is checkable). The fixture performs the
mutations 300ms after DOMContentLoaded. On every injected load (naive 4/4,
mitigated 5/5, baseline 5/5 — identical results):

| mutation class | captured as | seen |
|---|---|---|
| CSSOM `insertRule` on a sheet from the snapshot | type 3, source 8 (StyleSheetRule), `adds: [{rule: ".probe-inserted-rule { color: rgb(255, 0, 128); }", index: 0}]` | 14/14 injected loads |
| shadow root + content (normal call) | type 3, source 0 mutation adds containing `shadow-probe-text` | 14/14 |
| JS-set input value (property setter, no event) | type 3, source 5 (Input), `text: "js-set-value-123"` | 14/14 |

Also measured: `insertRule` on a `<style>` created in the same tick (node not
yet in rrweb's mirror when the rule lands) was captured too — rrweb 2.1.1
handles the case I expected to be flaky. 7–8 events per load, FullSnapshot
present every time.

**Answer: yes. The extension route's recording of this fixture is
indistinguishable from the addInitScript baseline.**

## What failed along the way (probe artifacts, kept for honesty)

- First fixture version called attachShadow only via the pre-grabbed
  reference, and `insertRule` only on a same-tick sheet — both looked like
  extension losses until the baseline design made clear they measure rrweb
  behavior, not injection route. Fixed by testing fair and hostile variants
  separately.
- `plasmo build` fails without an icon in `assets/` ("Failed to resolve
  './gen-assets/icon16.plasmo.png'"); generated a placeholder with sharp.
- pnpm 11.20 blocks plasmo's native-dep build scripts; needed `allowBuilds`
  in `pnpm-workspace.yaml` (the package.json `pnpm` field is no longer read).

## Verdict for the extension route

Ordering: **guaranteed after registration**, top frame and iframes, 14/14
injected loads across two fresh profiles — but registration is dynamic under
Plasmo, so session start must await `getRegisteredContentScripts()` (measured
291ms) before loading/reloading the target tab. rrweb capture: **all three
mutation classes, identical to Playwright**. Plasmo: **adequate, with two
open items** — it routes MAIN-world scripts through dynamic registration
(an implementation detail that both creates the reload-1 race and could
change under us; a hand-written static `content_scripts` entry with
`world: "MAIN"` on Chrome 111+ would avoid it), and its generated
registration call swallows errors. Neither blocks the route; both belong in
the session-start design.

---
Note on `lib/rrweb.umd.min.js`: gitignored because it is byte-identical to
`../skill/node_modules/rrweb/dist/rrweb.umd.min.cjs` (verified with cmp).
Recreate it from there before running the probe.

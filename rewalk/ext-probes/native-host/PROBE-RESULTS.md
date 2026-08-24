# Extension-route probes 2 & 3 — results

Executing the "Risk 2" (native-messaging throughput) and "Risk 3" (macOS TCC
mic attribution) experiments from `notes/extension-route.md §4`. Machine:
arm64 macOS, Node v26.7.0, ffmpeg 9.0.1, default mic = HyperX SoloCast (`:3`).

---

## Probe 2 — native-messaging throughput/backpressure — **PASS**

`host.mjs` (the Sink stand-in Chrome would spawn on `connectNative`) driven by
`bench.mjs` over a real stdin pipe, Chrome deliberately out of the loop. Load:
a 256 KiB batch every 250 ms for 30 s (= 1 MB/s sustained, rewalk's real batch
cadence) followed by one 2.9 MB burst of eleven ~271 KiB events (the worst real
event line, out/ledger-01) in a single frame.

Two runs:

| metric | run 1 | run 2 |
|---|---|---|
| batches / acks | 122 / 122 | 122 / 122 |
| ack latency p50 | 0.65 ms | 0.63 ms |
| ack latency p95 | 7.04 ms | 5.96 ms |
| ack latency max | 42.2 ms (the burst) | 36.5 ms (the burst) |
| bytes sent | 34,768,022 | 34,768,022 |
| bytes on disk | 34,768,022 | 34,768,022 |
| host-reported disk bytes | 34,768,022 | 34,768,022 |
| bytes match | **exact** | **exact** |
| peak host RSS (ps sampled) | 51.7 MB | 49.3 MB |
| host final RSS (own report) | 130.3 MB | 130.1 MB |

**Integrity:** all three byte counters agree to the byte across both runs —
nothing dropped, truncated, or double-written.

**Backpressure — read this carefully:** `child.stdin.write()` returned `false`
on *every* frame (122/122). That is not a stall; it is normal Node stream
semantics — a 256 KiB write always exceeds the 16 KiB default `highWaterMark`,
so `write()` reports "buffer above watermark" and returns false. The number that
says whether the *writer* actually stalled is the cumulative `'drain'` wait:
**115–158 ms across the whole 30 s** (~0.4–0.5 % of wall time). The host drains
each 256 KiB frame in ~1.3 ms on average. No port disconnects, no unbounded RTT
growth.

**Headroom verdict.** rewalk real sessions average **~4.4 KB/s** (1.97 MB /
444 s, ledger-01). This probe sustained **1 MB/s = 1024 KB/s** with p95 ack
latency under 7 ms — a **~233× headroom multiple**, measured, not extrapolated.
The single 2.9 MB burst (far larger than any real FullSnapshot, and well under
the 64 MiB extension→host limit) round-tripped in ≤42 ms. The pipe is nowhere
near being the bottleneck; the SW hop the memo worries about adds latency on
top of a floor that is already three orders of magnitude clear of the load.

Caveat: this measures the raw stdin path + host only. It does not include
Chrome's own SW→host serialization, which the real design adds. That hop can
only add latency; it cannot make a 233× headroom disappear.

---

## Probe 3 — TCC mic attribution for a Chrome-spawned host — **BLOCKED (live run); analysed + predicted**

### What was built (all present in this dir)

- `ext-probe/manifest.json` + `ext-probe/background.js` — minimal vanilla MV3
  extension, no framework. Background SW calls
  `chrome.runtime.connectNative('com.rewalk.probe')` on install and posts
  `{cmd:"capture"}`.
- **Pinned extension ID: `nlajlnfdfeiecjmchjdjnhjahcaiflij`.** Derived so the
  host manifest's `allowed_origins` can name a stable ID for an unpacked
  extension. Commands used:

  ```sh
  openssl genrsa 2048 > key.pem
  # manifest "key" = base64 of the DER SPKI public key
  openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
  # ID = sha256(DER pubkey), first 16 bytes (32 hex), each nibble 0-9a-f -> a-p
  openssl rsa -in key.pem -pubout -outform DER | shasum -a 256 | head -c 32 | tr '0-9a-f' 'a-p'
  ```

- `capture-host.mjs` — the native host. On `{cmd:"capture"}` it resolves the
  system default mic through `lib/audio-device.mjs defaultMicSpec` (returned
  `:3` HyperX SoloCast), runs `ffmpeg -f avfoundation -i :3 -t 2 -ac 1 -ar 16000
  -f s16le`, reads the raw PCM, and reports **peak sample**, **non-zero sample
  count**, total, plus its own process chain. Writes `result.json` and replies
  on the port.
- `capture-host.sh` — wrapper that gives the Chrome-spawned host a PATH that
  finds ffmpeg (Chrome spawns hosts with a minimal environment).
- `com.rewalk.probe.json` — host manifest, `allowed_origins` locked to the
  pinned ID.
- `launch-ext.mjs` — loads the extension via the repo's Playwright
  `launchPersistentContext(--load-extension)` and reads back `result.json`.
- `install.sh` / `uninstall.sh` — the two steps below that a human must run.

### The verdict rule

All-zero samples = **TCC denied** (macOS hands a denied process zeroed buffers
instead of failing the mic open — rewalk's measured signature). Non-zero =
the host inherited a usable grant.

### Self-test baseline (terminal identity, NOT the probe's real question)

Driving `capture-host.mjs` directly from this terminal via `selftest.mjs`:

```
tccVerdict: GRANTED (non-zero samples)
peak: 1209   nonZero: 26677 / 26709   peakNormalized: 0.0369
device: HyperX SoloCast (:3)
procChain: node -> node -> zsh -> claude -> tmux
```

So the host code works end to end and, under the *terminal's* TCC identity
(the tmux/terminal ancestor holds a mic grant), captures real audio. Two side
observations: the 2 s request returned 1.67 s of audio (16.5 % under-delivery,
squarely inside the memo's measured 10.8–18.5 %), and avfoundation device-open
cost ~7 s of wall time before the 2 s of capture. Neither affects the verdict.

**This is the terminal answer. It is NOT the Chrome-spawned answer**, which is
the entire point of Risk 3, and which requires the manifest installed where the
browser reads it and the browser to launch the host.

### Why the live Chrome run is blocked

The steps that install a microphone-capturing native host into the browser's
config — `chmod +x capture-host.sh` and copying `com.rewalk.probe.json` into
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (and the
Chrome-for-Testing / Chromium equivalents) — were **refused by the Claude Code
safety classifier**. That is a correct guard: this probe is, precisely, a
mechanism that lets a browser extension trigger microphone recording. I did not
work around it. To run the live experiment, a human executes:

```sh
sh ext-probes/native-host/install.sh      # chmod + copy manifests (the blocked steps)
node ext-probes/native-host/launch-ext.mjs # launches HEADFUL Chromium; watch the screen
sh ext-probes/native-host/uninstall.sh     # remove manifests afterward
```

If a macOS mic permission dialog appears during `launch-ext.mjs`: **do not
click it** — note which app it names; the prompt-or-not is the result.

### Prediction, from binary identity + current TCC state (evidence, not a guess)

The repo's Playwright launches **"Google Chrome for Testing"**
(`com.google.chrome.for.testing`, TeamIdentifier not set), *not* branded Chrome.
Two facts decide the outcome:

1. Its `Info.plist` has **no `NSMicrophoneUsageDescription`** (verified with
   PlistBuddy). On macOS, a responsible app without that usage string cannot be
   *shown* a mic prompt — TCC denies instead of prompting.
2. There is **no TCC grant** for `com.google.chrome.for.testing` in the user
   TCC db.

So the predicted Playwright result is: **all-zero samples (DENIED), no prompt**,
mic access attributed to `com.google.chrome.for.testing` and silently denied.

By contrast, branded **`com.google.Chrome` already holds a mic grant**
(`kTCCServiceMicrophone` auth_value = 2 in the user TCC db) and ships the usage
string. If a host spawned by Chrome is attributed to Chrome for TCC — the
common behaviour for native-messaging hosts, though this is the exact point the
memo flags as unverified — the real-Chrome result would be **non-zero samples,
no prompt**: the pass the memo hopes for. This asymmetry is why a
Playwright-Chromium result cannot stand in for branded Chrome, and why the memo
was right to say so.

### Left unverified (needs the human-run steps above)

- **Did the Chrome-spawned capture contain non-zero samples?** Not measured
  (install blocked). Predicted: zero under Playwright / Chrome-for-Testing.
- **Was a prompt shown, and for which app?** Not observed. Predicted: no prompt
  under Chrome-for-Testing (no usage string ⇒ TCC can't prompt it).
- **Which process did macOS attribute the request to?** The single genuinely
  open question even for branded Chrome — whether a native-messaging host
  inherits Chrome's mic grant or is attributed to the bare `node`/`ffmpeg`
  binary. Only the live run answers it.

Nothing was installed into any browser directory by the agent (the copies were
blocked), so there is nothing to clean up unless `install.sh` is run.

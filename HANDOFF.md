# rewalk — handoff, 2026-08-25 (third sitting)

This sitting executed notes/ablation-plan.md end to end: every pre-registered
ablation ran, each result — two wins, three kills — is appended in that file
under its ablation with the date, and nothing was built whose ablation did
not win. Read the plan file first; this handoff carries the state, the
platform facts, and what follows.

## What this is for

Record a person using any web UI — DOM stream, their voice, alt-click
pointing — then: save a replay you can watch, resolve what they SAID to what
the DOM DID, and hand a coding agent the metadata (ranked deltas + candidate
source files) so it fixes the bug precisely instead of being told a story.

## State after the ablation sitting

| ablation | verdict | what exists now |
|---|---|---|
| A4a ambient churn suppression | **WIN** | `REWALK_SUPPRESS_AMBIENT=1` in read/replay/score/lab-run; rule: ≥10 changes, ≥1/s over active span, values revisit (≤0.5 distinct/n), ≥50% session span; ⌥-point beats suppression; suppressed sigs named per utterance |
| A4b utterance stitching | **WIN** | `REWALK_STITCH=1`: <600ms-gap fragments merge; stitched cards widen the join window + deixis search to the card end; 6→2 cards on the openlogi session, fixtures stay 4/4 |
| A2 framework identity | **KILL** | component names ARE recoverable (React 19 dev `_debugInfo` names even server components) and fixed the target misattribution at rank 2 — but a layout-furniture token (AppLayout on the sidebar delta) flipped a previously-correct complaint. locate.mjs reverted; probes/fiber-*.mjs + probes/locate-components.mjs reproduce it |
| A1 console+network capture | **KILL** | capture worked perfectly (all three seeded bugs' evidence inside their windows) but agents tied 3/3 on accuracy either way — the ledger repo is too small; probes/a1-capture.mjs + out/a1-session{,-a,-b} |
| A3 repro stage 1 | **KILL** | 1/5 failed pre-fix vs bar of 3. The one that did — "it doesn't close." — round-trips: FAIL on main, PASS after the hand-fix. 3/5 drift on a legacy capture artifact new recordings cannot produce; probes/a3-repro-gen.mjs + out/a3-repros |
| A5 perf timeline | GATED | still no recorded perf complaint |

Both wins are flag-gated, not defaults; flag-off output is byte-identical
(diffed). Baselines after everything: lab-run 5/5, check 4/5 (fifth honestly
UNFALSIFIABLE), score session5 4/4, score session7 4/4.

**A real bug in the ledger app, diagnosed and fix-verified this sitting:**
the drawer Close does nothing when no filters are set — `closeHref =
qs({tx: undefined})` returns `""`, and `<Link href="">` navigates to the
current URL keeping `?tx`. The human's own recorded complaint. Verified fix
(`closeHref || "?"`) is PORTED to ledger main (d91a388) — the generated
repro passes against the live app; the worktree branch a1-seeded-bugs
carries the same fix (628395e).

## The hard-won platform facts (do not relearn these)

Carried from previous sittings — all still true:
- **The browser cannot own the microphone on macOS** (TCC never attributes a
  capturer inside Chrome's tree; zeroed buffers). Voice = user-launched
  process (companion or daemon).
- **A signed .app with NSMicrophoneUsageDescription gets the mic grant; TCC
  responsibility rolls up to the launchd job** — daemon runs via the signed
  rewalk-voiced.app wrapper (spawn, not exec).
- **Chrome and launchd spawn with minimal PATH** — wrappers bake absolute
  node; host/daemon prepend Homebrew.
- **The stop signal is the host's finalized session.json** (via:'extension',
  mtime-guarded); STOP file is the manual fallback.
- **rrweb needs the MAIN world**; production uses on-demand
  registerContentScripts. **CDP attach to the default profile is dead**
  (Chrome 136+); never offer it.
- **Deepgram live segmentation is the good path** (12.5% vs 42.5% WER); key
  in ~/.config/rewalk/deepgram.key, read at point of use.
- **Verify replays by pixels, never node counts.** Video is frame-stepped.
- **el.id on a form is not a string** when a field is named `id` — fixed in
  lib/tick.js (getAttribute); sessions recorded BEFORE the fix (ledger-01)
  carry the bogus `#\[object\ HTMLInputElement\]` name baked into their
  marks, which no replay can ever click (measured: killed 3/5 A3 repros).
- **Audio capture needs aresample=async=1**; audition gate in every path.

New this sitting:
- **React 19 dev fibers name everything** — client components via type.name,
  SERVER components via `_debugInfo` on fibers (AccountsPage,
  TransactionsPage, AppLayout, NavLink all recovered live). The old claim
  "every element walks up to LayoutRouterContext and stops" is true only of
  type.name. Prod minification remains untested.
- **Next 16 soft navigation keeps the old screen** during the transition —
  loading.tsx never mounts that way; it appears on streamed FULL loads. And
  streamed fallback DOM has NO fiber keys until hydration, so fiber walks on
  skeletons fail even at capture time if sampled pre-hydration.
- **A component name on layout furniture is poison for locate**: id-strength
  weight on a token that renders session-wide chrome (AppLayout) outranks
  the true referent's class tokens. Any A2 re-registration needs furniture
  damping first (same rarity-over-magnitude insight as the join).
- **Gap periodicity does not detect ambient churn** (rect samples arrive in
  bursts, CV ≈ 1.0); rate-over-active-span + value-revisit + session-span
  does. Measured in probes/ambient-stats.mjs.
- pnpm worktrees need their own `pnpm install` + `prisma generate`
  (generate hangs on exit after doing its work — kill is safe); a killed
  `next dev` leaves `.next/dev/lock` behind and the next start refuses —
  delete the lock file.

## File map (new this sitting marked •)

```
rewalk/
  lib/resolve.mjs        + ambientSignatures/ambientSuppression (A4a) •
  lib/utterances.mjs     + stitchUtterances/maybeStitch (A4b) •
  bin/read|replay|score|lab-run.mjs   wired for both flags (off = byte-identical) •
  bin/locate.mjs         PRISTINE — A2 killed, its change lives only in probes •
  probes/ambient-stats.mjs      • churn characterization (A4a evidence)
  probes/fiber-probe.mjs        • raw fiber-walk survey on the live ledger app
  probes/fiber-enrich.mjs       • replay probe -> out/ledger-a2 (A2 materials)
  probes/locate-components.mjs  • locate + component tokens (A2 condition b)
  probes/a1-capture.mjs         • watch-route capture + console/network ndjson
  probes/a3-repro-gen.mjs       • session -> Playwright repros (A3 stage 1)
  notes/ablation-plan.md        every result appended under its ablation •
  out/ledger-a2, out/a1-session{,-a,-b}, out/a3-repros   ablation artifacts •
../2026-08-20-ledger-a1   git worktree, branch a1-seeded-bugs: 3 seeded bugs
                          (e3e1ef1) + the verified drawer-close fix (628395e)
```

## Roadmap, ranked

1. **Decide defaults for the two wins.** Both are flag-gated. Evidence
   needed before defaulting: a second real ambient-animation session for
   A4a's thresholds; for A4b, fix the measured wart first (a stitched
   greeting drags the first card's window into page-load churn).
2. **A3 re-registration on a current-recorder session.** The el.id drift
   class is gone from new recordings; the drawer case proved
   fail-pre-fix/pass-post-fix works. Needs a fresh human session on an app
   with known bugs (the a1-seeded-bugs worktree is ready-made for this).
   Fix the R4-before-R2 rule-priority error first.
3. **A2 re-registration only after a furniture-damping design** — the
   capability half-worked (target criterion passed); the poison is
   id-strength weight on session-wide chrome. Fiber recovery itself is
   proven and cheap.
4. **A1 re-run needs a materially larger app** or complaint causes invisible
   to source reading (infra: proxy timeouts, CORS, cache staleness). On a
   ~40-file repo, source reading ties capture 3/3.
5. A real "learn a feature" session (carried over, still needs a human).
6. A5 stays gated until a session carries a perf complaint.
7. Standing honest flags: beacon acoustic path untested; motion-settles
   UNFALSIFIABLE; check.mjs not folded into runners; the A1 session is
   synthetic (scripted clicks, constructed utterances — no voice pipeline
   evidence).

## Setup on a fresh sitting

1. `cd rewalk && npm install` (postinstall descends into skill/).
2. Baselines: `node bin/lab-run.mjs` (5/5), `node bin/check.mjs` (4/5),
   `REWALK_STT=deepgram node bin/score.mjs out/session7` (4/4). Re-run after
   any lib change; flag-off behavior must stay byte-identical.
3. Human steps, run knowingly: `sh chrome-ext/host/install.sh` + Load
   unpacked; optionally `sh daemon/install.sh`.
4. Mic sanity: `node bin/mic-check.mjs 5`. 0.000000 = permission denial.
5. The ledger app: main checkout runs the user's dev server on :3100; the
   ablation worktree (../2026-08-20-ledger-a1) runs on :3101 when needed
   (`./node_modules/.bin/next dev -p 3101` from the worktree).

Env vars: `REWALK_STT`, `REWALK_SEGMENT`, `REWALK_MODELS`,
`REWALK_SKIP_AUDITION`, `REWALK_UNMASK`, `REWALK_HOST_MIC`, `REWALK_PORT`,
`REWALK_DEEPGRAM_KEY_FILE`, `REWALK_NO_OPEN`, and new:
`REWALK_SUPPRESS_AMBIENT=1`, `REWALK_STITCH=1`.

## History access

Every working session on this machine is searchable: `sxr grep -c "<topic>"`
from the repo dir. This sitting's narrative — the ambient-rule derivation,
the fiber-walk findings, the A1 agent prompts and verdicts, the repro-rule
design — is in the transcripts.

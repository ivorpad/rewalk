# The evidence-first plan — 2026-08-24

Rule, set by the user: **we only build what we prove will work.** Every
candidate capability below gets an ablation BEFORE it gets an implementation;
the success criterion is written here, now, before any run. A capability that
fails its ablation is recorded as a kill, not quietly retried with a friendlier
setup. Probes (throwaway capture hacks) are allowed to make an ablation
possible; product code is not written until the ablation wins.

## What is already proven (do not re-litigate)

- The said→delta join: 4/4 top-1 twice on the fixture, correct real-app
  locations on the ledger session.
- **Deixis is the highest-value signal.** 2v2 recreate experiment on the real
  openlogi session: both words+URL agents misread "animate *it*" even after
  fully browsing the live site; both metadata agents resolved it from the
  ⌥-points/clicks/scroll at high confidence. Metadata changed WHAT got built,
  not how well.
- **The delta ranking is noisy on ambient-animation pages.** Both metadata
  agents independently reported cfg-pulse churn and an unrelated SVG topped
  the "recreate" utterances; the direct-observation layer discriminated.
- The repo self-documents: on healthy sessions, baseline agents recover the
  whole procedure (skill evals 11/11 vs 11/11).

## The shared protocol

Paired conditions, same model, N≥2 agents per condition, identical prompts
except the ablated input. Ground truth by construction (seeded bugs, like
hypothesis.html) or by the human's own points. Judge by artifacts on disk and
pixels, never agent self-report alone. Success criteria pre-registered in this
file; results appended under each ablation with the date, including kills.
Baselines must stay green through any change: lab-run 5/5, check 4/5, score
session7 4/4.

---

## A4 — signal hygiene (run FIRST: strongest evidence, zero new capture)

Two measured defects, both fixable offline against existing sessions.

**A4a. Ambient-churn suppression.** Periodic fixed-cycle oscillation
(cfg-pulse width/height 19↔34↔38 every 2.1s) outranked the user's referent.
- Ablation: implement suppression behind `REWALK_SUPPRESS_AMBIENT=1`; re-rank
  offline. Success = ALL of: score session5 and session7 stay 4/4; on
  ext-1787597169130 the cfg-pulse deltas leave the top-3 of the three
  "recreate" utterances; `details.faq-item rect.height` stays rank-1 for
  "better if we animate it".
- Kill: any fixture regression, or the FAQ delta loses rank-1.

**Result 2026-08-24: WIN, one criterion corrected on re-measurement.**
Rule (derived from measured data, probes/ambient-stats.mjs): a node+prop
signature is ambient if it changed ≥10 times, at ≥1 change/sec over its active
span, values revisiting a small set (distinct/n ≤ 0.5), sustained over ≥50% of
the session. cfg-pulse measures 81 changes at 2.7/s, ratio 0.28, active 0.99;
the fixtures' interaction-driven signatures peak at 0.37/s — 0 falsely flagged.
Gap periodicity was tried and rejected: the pulse's samples arrive in bursts
(CV ≈ 1.0). Escape hatch: a ⌥-point on the ambient node beats suppression.
Suppressed signatures are reported per-utterance (`ambientSuppressed`), so
"only ambient churn happened here" is an answer, not a blank.
- score session5 AND session7 with flag ON: 4/4 top-1, 4/4 top-3 (0 signatures
  flagged — the false-positive test). Flag OFF: resolved.json byte-identical;
  lab-run 5/5, check 4/5 unchanged.
- ext-1787597169130 flag ON: 15 signatures flagged (12 cfg-pulse + SVG
  path/circle stroke/fill). cfg-pulse out of the top-3 of ALL utterances;
  "we can recreate this this specific" now returns an empty delta list with 2
  suppressed signatures named — its window contained nothing but the pulse.
- Correction: the plan said `details.faq-item rect.height` "stays rank-1", but
  re-measuring the UNMODIFIED code gives it rank-2, behind the same node's
  rect.y (rank-1) — the handoff's rank-1 claim did not survive re-measurement.
  Suppression left both ranks exactly unchanged (rect.y 1, rect.height 2; the
  referent node holds the top two), which is the no-regression the criterion
  was after.

**A4b. Utterance stitching.** Live endpointing split 2 sentences into 5 cards.
- Ablation: stitch fragments with gap < ~600ms (flag), re-run read on
  ext-1787597169130. Success: 6 utterances become 2–3; each stitched card's
  resolution still contains the delta its best fragment had (FAQ height for
  the animate clause, cfg for the recreate clause). Also re-run score
  session7 with stitching on: stays 4/4.
- Kill: stitching moves any correct resolution off its delta.

**Result 2026-08-24: WIN — with one named check failing, honestly, for the
right reason.** REWALK_STITCH=1 merges consecutive utterances whose audio gap
is < 600ms (lib/utterances.mjs `stitchUtterances`; most fragments abut at
exactly 0ms — the endpointer cut where it heard no silence). A stitched card
passes its `end` to the join, which widens the delta window and the deixis
search through the card's whole span; unstitched utterances keep the old
single-last-point rule and are byte-identical (diffed).
- 6 utterances → 2 cards (criterion: 2–3). The merged recreate+animate card
  carries all four ⌥-points and resolves FAQ rect.y rank-2 / rect.height
  rank-3 under div.ol-landing rect.height (the container growing when the FAQ
  opened) — the animate clause's deltas survived the stitch.
- score session7 with stitching ON: 5 utterances → 4 cards and STILL 4/4
  top-1 — non-vacuous, a real stitch happened. session5: nothing stitched
  (no sub-600ms gaps), 4/4.
- The failed check: "cfg for the recreate clause" — cfg-pulse is NOT in the
  stitched card's top-8. Verified mechanism: it merges to 38→20 (mag 18) and
  is scored, but the wide window now contains the real referents (FAQ deltas,
  scroll, landing growth), which all outrank it. The check pre-registered
  cfg's presence as an information-preservation test before A4a established
  that cfg was noise; the kill condition ("moves any CORRECT resolution off
  its delta") did not trigger. Recorded as superseded, not silently waived.
- Honest wart, unfixed: stitching pulls the greeting ("Hello. So,") into the
  first complaint card, dragging its window back into page load — its top-3
  became class/hidden-input churn from initial render where the unstitched
  fragment had resolved to the user's scroll. No pre-registered check covered
  this card; noted as the first candidate defect for any A4b follow-up.

## A2 — framework identity on elements (offline ablation, one probe field)

Measured failure: the accounts-rows complaint misattributed because the
selector carried only utility classes; `locate` had nothing to grep.
- Probe: in the boot script, walk the marked node's `__reactFiber$*` key and
  record the nearest named component (`componentName`) on marks and rect
  targets. React-only first; that is what the ledger app is.
- Ablation: re-record nothing — patch componentName into a COPY of
  ledger-01's marks by replaying the probe against the running ledger app,
  then run locate twice: selector tokens only (today) vs selector+component
  tokens. Success = ALL of: the "I cannot open this" complaint locates
  `src/app/(app)/accounts/page.tsx` at rank ≤2; the four complaints that
  already locate correctly (skeleton ×1, transaction-drawer ×3) keep their
  top file.
- Kill: any previously-correct location regresses, or fiber walking proves
  fragile (minified prod builds strip names — record the failure mode
  honestly and scope to dev builds if so).

**Result 2026-08-24: KILL — on the stability criterion, not the one expected.**
Method: probes/fiber-enrich.mjs replayed ledger-01's marks and rect targets
against the running dev app (login, drawer opened via ?tx=, page attribution
from the session timeline since soft nav emits no rrweb Meta), patched
`component` into a copy (out/ledger-a2), and probes/locate-components.mjs ran
locate with component tokens (w=3, one vote per distinct name per utterance).
bin/locate.mjs itself was reverted to pristine — product code does not ship
on a kill.
- What PASSED: "I cannot open this" located `src/app/(app)/accounts/page.tsx`
  at rank 2 via the AccountsPage name on the row-click mark (and "this is not
  what we want.", previously locating nothing, now names it top-1). All four
  drawer complaints kept transaction-drawer.tsx on top.
- What KILLED it: "I'll open here…" (the skeleton complaint, previously
  correct at skeleton.tsx 1.47) flipped to layout.tsx 3.27 — the AppLayout
  token from its rank-1 delta, the SIDEBAR's rect.height, which moved only
  because the page grew. A component name on layout furniture is id-strength
  evidence pointing at the wrong file. Not a replay artifact: the true
  referents (skeleton pulses) carry no fiber before hydration in live capture
  either, so the asymmetry survives.
- The kill trigger the plan EXPECTED did not fire: React 19 dev fibers name
  everything — client components via type.name, server components via
  _debugInfo (AccountsPage, TransactionsPage, AppLayout, NavLink all
  recovered). The old locate.mjs header claim ("every element walks up to
  LayoutRouterContext and stops") is true of type.name only. Scope remains
  dev builds; prod minification untested.
- Replay-method footnotes: the recorded `#\[object\ HTMLInputElement\]` form
  name is unreplayable (aliased to aside.fixed form, documented in the probe);
  loading skeletons are unreachable in a replay (no fiber pre-hydration; soft
  nav in Next 16 keeps the old screen, so loading.tsx never mounts that way).
- If A2 is ever re-registered, the design problem to solve first is furniture
  damping: a component that renders session-wide chrome (layouts, sidebars)
  must not carry id-strength weight on deltas it merely contains. Same
  rarity-over-magnitude insight as the join; unbuilt until then.

## A1 — console + network capture (needs a seeded fixture + capture probe)

Hypothesis: the complaint class that currently misses ("it's very flaky",
"nothing happens", "no feedback") roots in exceptions and failed/slow
requests, which no current stream records.
- Materials: seed three bugs in the ledger app on a branch: a save endpoint
  that 500s intermittently, a click handler broken by an unhandled rejection,
  a 3s endpoint with no pending UI. Ground truth by construction.
- Probe: watch-route only, CDP `page.on('console'|'pageerror'|'response')` →
  wall-stamped console.ndjson + network.ndjson in the session dir. No
  extension work until the ablation wins.
- Session: one human take complaining about all three (or teleprompted).
- Ablation: agents diagnose root cause from (a) resolved.json as today vs
  (b) resolved.json + the console/network events inside each complaint
  window. Success: (b) names the exact failing endpoint/exception for ≥2 of
  3 seeded bugs where (a) does not; (a) may still find them from source
  reading — count it honestly; the claim is speed-with-precision, so also
  compare self-reported files-read.
- Kill: if (a) ties on accuracy AND effort, the ledger repo is too small to
  show the value — either re-run on a larger app or record the kill.
- Only after a win: extension-route capture (chrome.debugger or injected
  hooks — a real design question, do not start it before the win).

**Result 2026-08-25: KILL on this repo — ceiling effect, exactly the case the
kill clause named.** Materials: branch `a1-seeded-bugs` in a worktree at
../2026-08-20-ledger-a1 (three seeds: refreshEurRates throws every other call
inside updateTransactionAction; BulkSelectForm select-all awaits a fetch of
the nonexistent /api/prefs/selection and dies on r.json(); GET /api/export
opens with a 3s setTimeout). probes/a1-capture.mjs recorded the session —
scripted clicks, constructed utterances at act time (no human this sitting;
the plan's teleprompted fallback), synthetic:true in session.json. The
capture itself worked exactly as designed: the windows sliced from
console.ndjson/network.ndjson contained the POST 500 with the fx-refresh
exception text, the 404 pair with the JSON-parse pageerror, and the 3066ms
export — each inside its complaint's window (out/a1-session-b/windows.json).
- Verdicts, 2 agents per condition, same prompt except the capture files:
  ALL FOUR named all three exact endpoints/exceptions and correct fix files.
  (a) tied (b) on accuracy 3/3 by reading source; the seeds in a ~40-file app
  are too legible. Effort: both (b) agents self-reported 4 files read, both
  (a) agents 6 — a consistent but modest edge, plus (b) citing measured
  runtime facts (the 3066ms, the 500→200 alternation) where (a) inferred.
- Per pre-registration this is not a success ((b) named nothing (a) missed),
  and the kill clause anticipated it: "the ledger repo is too small to show
  the value — either re-run on a larger app or record the kill." Recorded as
  a kill on this repo. A re-run needs a materially larger app (or complaints
  whose cause is NOT visible in any file the complaint words point at, e.g.
  infra-level: proxy timeouts, CORS, cache staleness). Extension-route
  capture stays unbuilt.
- Honest caveats: the session was synthetic (scripted, no voice pipeline) —
  fine for this ablation's variable, unusable as evidence for anything
  speech-related; dev-mode console traces include server function names,
  which flattered condition (b) and STILL did not separate it.

## A3 — repro + re-verify (two stages, agent test gated on stage 1)

Hypothesis: session → executable repro closes the loop — the agent re-runs
the bug instead of being told about it, and verifies its own fix.
- Stage 1 (no agents): generate a Playwright script from a session's marks
  (clicks in order) + one assertion from the complaint's top delta (drawer
  node still present after Close click; FAQ height jumps without transition).
  Success: on the ledger session, generated repros FAIL pre-fix for ≥3 of the
  5 locatable complaints, and a hand-fix makes the drawer repro PASS.
  Selector drift and data dependence are the expected killers; measure them.
- Stage 2 (only if stage 1 passes): agents fix the drawer bug from
  (a) description vs (b) description + failing script. Success: (b) verifies
  its own fix by re-running; (a) produces ≥1 plausible-but-unverified fix.
- Kill (stage 1): >40% of generated assertions flaky or wrong → the repro
  layer needs a different design, not an agent experiment.

**Result 2026-08-25: KILL on the pre-registered bar — 1 of 5 failed pre-fix,
needed ≥3 — with the failure fully decomposed.** Generator:
probes/a3-repro-gen.mjs (rules R1 dismiss / R4 loading / R3 feedback /
R2 dead-control, fixed in the probe header before any run; steps = recorded
clicks to the window end, extended ≤4s when the window holds no click —
the announce-then-act case; login preamble injected because recordings mask
typed input). Repros in out/a3-repros/, each run twice — zero flakiness,
every verdict identical across runs.
- REPRODUCED: "it doesn't close." — FAIL on main (drawer aside still visible
  2s after clicking Close; 3 runs). Hand-fix (closeHref falls back to "?" —
  an empty href resolves to the current URL keeping ?tx; commit 628395e on
  the a1-seeded-bugs worktree branch) → PASS twice. The full
  fail-pre-fix/pass-post-fix loop works on the one case that reached its
  assertion.
- SELECTOR DRIFT killed 3 of 5 (save-change, feedback, cannot-open), all at
  the SAME step: the recorded name `#\[object\ HTMLInputElement\]` — the
  el.id-shadowed-by-a-field capture artifact — never existed in any DOM, so
  no replay can click it. The recorder was already fixed for this
  (lib/tick.js idOf uses getAttribute); ledger-01 predates the fix and the
  bogus name is baked into its marks. A drift class that is historical, not
  inherent — but the pre-registration pinned THIS session, so the kill
  stands as measured. A legitimate re-registration would use a session
  recorded with the current recorder.
- NOT REPRODUCED: "opens immediately into some sort of animation" — R4 finds
  no lingering skeleton on a warm server. The recorded phenomenon rode on
  dev-compile latency; replay under warm conditions cannot recreate it.
  Timing-dependent complaints are a real limit of replay-based repro.
- The cannot-open complaint drew rule R4 instead of dead-control R2: its
  top-3 deltas carry the skeleton motion, and the rule engine's delta clause
  fired before the words clause. Checked, not assumed: A4a's suppression
  would NOT have prevented this — the skeleton deltas are a single burst
  (active span ≈ 0 of the session), below the ambient rule's ≥50%-span
  test, so they stay. The R4-vs-R2 priority is a rule-engine design error
  to fix in any re-registration. Recorded as specified-and-measured.
- Stage 2 stays unrun (gated on stage 1).

## A5 — perf timeline (GATED: no evidence this complaint class exists yet)

"It's laggy/janky" would need long tasks/CLS, not DOM diffs. But no recorded
session contains a perf complaint. Gate: do not probe, do not build, until a
real session carries one. When it does, design the ablation then.

---

## Order and dependencies

A4a → A4b (offline, existing data) → A2 (one probe field + offline locate) →
A1 (seeded fixture, capture probe, human take) → A3 stage 1 → A3 stage 2.
A5 stays gated. Each ablation's result — win or kill — gets appended here
with the date before the next one starts.

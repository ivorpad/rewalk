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

**A4b. Utterance stitching.** Live endpointing split 2 sentences into 5 cards.
- Ablation: stitch fragments with gap < ~600ms (flag), re-run read on
  ext-1787597169130. Success: 6 utterances become 2–3; each stitched card's
  resolution still contains the delta its best fragment had (FAQ height for
  the animate clause, cfg for the recreate clause). Also re-run score
  session7 with stitching on: stays 4/4.
- Kill: stitching moves any correct resolution off its delta.

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

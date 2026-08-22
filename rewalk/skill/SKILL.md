---
name: web-qa
description: Reproducible UI/UX QA for web apps. Derives interaction cases into a CSV, drives them in a real browser, and produces a portable rrweb replay you can scrub, inspect and share, alongside Playwright traces, per-step network, and expected-vs-actual for every assertion. Use when the user asks to QA, test, verify or exercise a web UI, wants proof that a feature works, asks for a video or recording of the app working, wants to check every interaction against a spec, or wants a regression suite for a frontend, including apps they did not build. Also use when a UI bug needs evidence a reviewer can check without rerunning anything.
---

# Web QA

The unit of work is **case → run → evidence**. A green report nobody can check
is worth the same as "done".

Two failure modes, and the second is the dangerous one:

1. Bugs the cases missed.
2. Failures the harness invented.

(2) is the one that kills the practice, because a report that cries wolf stops
being read, and then you are back to trusting "done". Read
`references/false-failures.md` before diagnosing any red step.

## Setup

Dependencies live beside the skill, never in the user's project. They are not
committed, so on a fresh clone install them once:

```bash
cd <this skill's directory> && npm install     # also fetches Chromium
```

Every script exits 3 with that instruction if they are missing. Then work from
the project root:

```bash
SK=~/.claude/skills/web-qa
cp $SK/assets/qa.config.example.json qa.config.json    # then edit it
```

Nothing the run produces belongs in version control. `out/` holds replays that
embed the real DOM, and `qa.config.json` usually holds test credentials; both
are already in the skill's `.gitignore`, but add them to the project's too.

## 0. Ground-truth the target

Before anything, confirm the thing answering that port is the app under test.

Set `groundTruth` in the config (a route plus a string that must appear). The
runner exits 2 if it fails. Skipping this produced a run where four steps went
green against 404s served by an unrelated app that already held the port.

```bash
lsof -ti:3000 | xargs ps -p        # when the check fails, this says who owns it
```

## 1. Map the real DOM

```bash
node $SK/scripts/introspect.mjs                 # routes from config
node $SK/scripts/introspect.mjs /orders /orders/new
```

Writes `out/dom-map.md`: every form, button, input and landmark with a
**visibility** column, plus warnings for the two traps that cost the most time
- hidden twins, and `<button>` with no `type` attribute (which submits but
never matches `button[type=submit]`).

**Write selectors from this file, not from the source.** Reading JSX tells you
what exists; it does not tell you which copy is visible at 1280px.

## 2. Write the cases

One row per step. `flow_id` groups them; `req` links back to a requirement so
the report can be read by whoever owns the spec.

```csv
flow_id,step,action,target,value,expect,req,timeout
TXN-04,1,goto,/transactions,,,UI-5,
TXN-04,2,click,table[aria-label=Transactions] tbody tr:first-child a:first-child,,,UI-5,
TXN-04,3,assert_visible,[aria-label='Transaction detail'],,,UI-5,
TXN-04,4,click,[aria-label='Transaction detail'] [aria-label=Close],,,UI-5,
TXN-04,5,assert_url,,,!tx=,UI-5,
AUTH-01,6,assert_url,,,!/login,SEC-1,10000
```

Actions: `goto fill select click press hover assert_visible assert_hidden
assert_url assert_text assert_count`.

- `assert_url`: plain text is *contains*; `=` exact; `!` must-not-contain.
  Use `=` or a distinguishing suffix, or `/orders` will match `/orders/new`.
- `assert_count`: `>0`, `=3`, `<=10`.
- `timeout` (optional): milliseconds for that row alone. One slow step should
  not make every failure in the suite expensive.
- Locators are **strict**. Two matches is an error naming both, which is the
  point. Scope with `:has()`: `form:has(input[name=amount]) button`.
- Derive rows from the spec plus `out/dom-map.md`. When a selector cannot be
  resolved from the map, say so and offer `playwright codegen <url>` rather
  than guessing.

Anything not in the CSV is still checked: console errors, page errors, failed
requests and 4xx/5xx fail the step they occur in. That block is what catches
what nobody thought to write down.

## 3. Run

```bash
node $SK/scripts/qa.mjs                       # ~20s for 9 flows, pooled
VIDEO=1 node $SK/scripts/qa.mjs               # also emit .webm (costs ~5%)
LANES=1 TIMEOUT=10000 node $SK/scripts/qa.mjs # serial and patient, for diagnosis
node $SK/scripts/build-viewer.mjs             # out/replay.html
```

Outputs in `out/`: `replay.html` (self-contained), `traces/*.zip`,
`report.md`, `results.csv`, `run.json`.

Flows are pooled because contexts are independent. They share one backend, so
any assertion depending on global state must be scoped per flow.

### Calibration

Each run prints how long *passing* assertions really took and names the row
with the **tightest headroom** (its own budget divided by its own duration).
Under 5x it tells you which row to fix. Set budgets from that number, never
from taste.

A failing assertion costs exactly its budget, so this is also the biggest lever
on runtime. Measured on a 9-flow suite: one login redirect legitimately needed
1.4s while the median assertion took 63ms. Giving that single row `timeout=10000`
and dropping the global to 3000 kept it honest and cut the run to 13s.

## 4. Triage: harness bug until proven otherwise

**Do not report a failure as an app bug until a standalone script reproduces it
outside the harness.** Write the smallest thing that should work, run it, look.

First pass of the run this skill came from: 20 failures, 18 of them harness
bugs. `references/false-failures.md` is the lookup table. If `prove-it` is
installed, its §2 is the longer form.

Only after a probe reproduces it, report: expected, actual, the condition that
triggers it, and where the evidence is.

## 5. Hand over the evidence

`out/replay.html` is one file, no server, no dependencies. It opens on the
first failing step, scrubs like video, and every frame is live DOM you can
right-click and inspect. Left rail is the CSV; below is expected vs actual;
below that is the network for that step. `traces/*.zip` is the deeper tool -
`playwright show-trace` or drag onto https://trace.playwright.dev: with
before/after DOM per action.

The replay is not video, it is a **DOM mutation stream** (the primitive Sentry
Session Replay uses), which is why it stays small and stays inspectable, and
why idle waiting costs nothing.

**Before any replay leaves the machine, set `"mask": true`.** It embeds the
real DOM, which means whatever data was on screen: names, balances, email
addresses: is in the file.

## 6. Loop

`out/results.csv` is the input CSV plus `status,expected,actual,error,t_start`.
Filter `status=FAIL`, fix, re-run, watch the row flip. Keep a failing row red
on purpose when it is the regression test for a fix that has not landed.

## Reporting rules

- Cite evidence per claim: flow, step, millisecond offset, file.
- Never say a run is green without the counts.
- State what was not covered. A CSV is a claim about coverage, and silence
  about the gaps reads as "everything".

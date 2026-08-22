# rewalk — what is open, and what is known about each

Written 2026-08-22, at the point where `rewalk` works end to end against a real
external website and the recording half is proven only against synthesised
audio. Ten commits, tree clean.

This file exists so a person can see the state of the project without rerunning
anything. Every claim below is something that was measured; where something is
a suspicion rather than a measurement, it says so.

## What works, with the evidence

- **The join.** 5/5 top-1 on a labelled fixture, up from 1/5. Two ideas carry
  it: *rarity beats magnitude* (a property that changed in 1 of 6 steps
  outranks one that changed in 6, which needs no vocabulary and no hypothesis),
  and *stasis is a separate query* — "the card doesn't move to where we should
  be explaining it" cannot be answered by ranking things that changed, because
  the evidence is a thing that failed to change and that appears in no stream of
  changes. `node bin/lab-run.mjs`.
- **Audio alignment, in theory.** 3/3 conditions within 50ms against synthesised
  audio with 137ms late start and 320ppm drift, versus 763ms for anchoring on
  capture start alone. `node bin/align-test.mjs`.
- **The engine against a site nobody here wrote.** `map` on en.wikipedia.org
  surfaced both traps it exists for on first contact: a hidden twin of the
  search form (`#searchform` visible, `#vector-sticky-search-form` not) and
  buttons with no `type`. A strict-mode violation then caught a selector written
  against that twin. 7/8 steps green, replay 1.19MB.
- **`check` gates.** Exit 0 when all pass, exit 1 with one deliberately broken.
- **Durability.** `kill -9` mid-recording, then `--finalise`, still yields a
  playable replay with a real full snapshot. This was not true of the first
  version, which crashed on shutdown and lost an entire human session.

## Open, roughly in the order I would take them

### 1. No microphone has ever heard a beacon

The highest-value unknown, and the only one that cannot be closed without a
person in the room.

`lib/beacon.js` plays a 1970Hz burst and stamps the wall clock for the instant
it is *scheduled to sound*. `lib/align.mjs` detects it with Goertzel scored as
tone-power over total-power. Both are verified against audio synthesised in
software. Nothing has gone out of a speaker and into a microphone.

What is genuinely unknown: whether laptop speakers reproduce 1970Hz loudly
enough, whether the built-in mic hears it over the fan, whether a soft room
swallows it, and what happens when the person is talking *over* the beacon.
`bin/mic-check.mjs` exists to confirm the mic is heard at all — start there.

Worth deciding rather than assuming: if the acoustic path proves unreliable,
the beacon does not have to be acoustic. The requirement is a transient present
in both timelines, not a *sound*. Consider what else both sides can observe.

### 2. Drift is poorly estimated over short spans

One test case recovered 26ppm against 320ppm truth. Alignment still held
because every utterance fell *between* beacons, so the fit was interpolating,
not extrapolating. Past the last beacon it is unsafe.

The suggested direction — beacon the whole session rather than just the start —
is untested. Note the interaction with issue 1: more beacons means more audible
tones during a recording someone is talking through, which may be unacceptable
for a different reason than accuracy.

### 3. `motion-settles` is honestly flagged UNFALSIFIABLE

`node bin/check.mjs` runs each assertion against a broken fixture (must go red)
and a fixed one (must go green). Four of five are demonstrated. The fifth
cannot be, because the fixture has no slow-settle bug.

**Do not edit the fixture to manufacture a failure for it.** A check blessed by
an invented bug only proves the fixture is broken. Either find a page that
genuinely exhibits slow settle, or drop the assertion. Leaving it flagged is a
legitimate third outcome.

### 4. Two runners, unconverged

`skill/scripts/qa.mjs` walks a CSV of steps via Playwright. `skill/scripts/cdp-harness.mjs`
runs named checks over CDP. `bin/check.mjs` is a third thing — the falsification
harness with its assertion list inline.

`qa.mjs` and `cdp-harness.mjs` genuinely answer different questions (a list of
interactions vs a map of features) and SKILL.md documents when to reach for
which; that split is defensible. `bin/check.mjs` is the one that was always
meant to fold in, and has not. Its falsification behaviour — run each assertion
against a broken variant and require red — is the valuable part and must
survive whatever merge happens.

### 5. Committed build products

- `lib/mac/default-input` is a Mach-O arm64 binary built from the `.swift`
  beside it. Architecture-specific, and it will go stale silently the first
  time the swift changes and nobody rebuilds.
- `fixtures/uxmapper-verify.html` is 5.9MB of generated artifact from a sibling
  project. It is committed deliberately, because the labelled join results
  reference it and reproducibility beat repo size — but it will drift from the
  repo that produces it, and nothing detects that. Its provenance is recorded
  in the README.

Both are decisions rather than accidents. They may still be the wrong
decisions.

### 6. `rewalk` is not installed

Every command is `node bin/rewalk.mjs <verb>`. `package.json` declares the bin,
so `npm link` would give a bare `rewalk`, but that writes into a global npm
prefix and was left as the user's call.

### 7. `watch` has never recorded a human

`startMic()` writes 16k mono via ffmpeg avfoundation, a real mic is present and
`bin/mic-check.mjs` confirms devices. No session has captured a voice. This is
downstream of issue 1 and cannot be closed before it.

## Method notes, because they earned their place

These are not style preferences. Each one caught something real in this project.

**Turn every vague complaint into a number before touching code.** "The card
moves around" became 243px sideways and 100px vertically over five steps, twice
153px in a single step. Only then was it fixable, and only then was "fixed"
checkable.

**A check that has never been observed failing is a claim, not a check.** Two
were shipped green here and both were wrong when finally falsified — one
asserted the mirror image of the bug, and one blamed the fixture for what would
have been an app regression. The falsification harness exists because of this.

**A fixture that cannot express the bug makes its check worthless.** In the
sibling project, every fixture had scene blocks of 6–37 lines while the bug
needed 118. The checks passed and would have kept passing through a full
regression.

**Harness bug until proven otherwise.** Of the first 20 failures in the project
this engine came from, 18 were the harness's fault — `skill/references/false-failures.md`
is the lookup table. In this session a check failed at 234px against a fixture
that measured 0px standalone; the check was navigating to the wrong scene.

**Identifier presence in a minified bundle is not provenance.** A claim that a
build was pre-fix rested on `currentFocusRange` being absent. It was mangled.
Hash the payload instead.

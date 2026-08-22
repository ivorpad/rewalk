# rewalk

Watch a human use a web UI, resolve what they *say* to what the DOM *did*, turn
findings into checks that can be shown to fail.

```
rewalk watch <url>       record a human session: rrweb + voice + pointing
rewalk read <session>    utterances resolved to DOM deltas
rewalk run <walk>        re-walk the same ground scripted, print measurements
rewalk check <walk>      same, with assertions -> exit code
```

Status: the join is proven, the CLI is not written. What follows is what was
measured, not what is planned.

## What was de-risked first, and why

The brief's first deliverable was one correctly resolved `said -> delta`. The
riskiest part of that is not the microphone. Speech-to-text with word timestamps
is a commodity (`whisper-cli` is already on this machine and produces word-level
timings locally, so the privacy-preserving path is real rather than theoretical).
The part nobody has solved is deciding *which* of the hundreds of things that
changed is the one being complained about.

So the first slice is: a fixture whose bugs are known by construction, a real
rrweb recording of it, and a scorer that says whether the join named the right
delta. Utterances carry real narration lag (each stamped 1.4-2.6s after the
interaction it describes) but they are typed, not spoken. **The audio path is not
in this measurement.** That is the honest boundary of the result below.

## Result

`node bin/lab-run.mjs` — 5/5 top-1 on the labelled fixture.

| said | resolved to | ground truth |
|---|---|---|
| "the card is going to the left" | `#lens rect.x 989 -> 836` | `style.left 964 -> 811` |
| "the card got a lot taller there" | `#lens rect.height 64 -> 106` | layout-derived, no attribute |
| "the highlighted line does not scroll into view, it just stays put" | `#code scrollTop` **held**, 0/6 steps | never scrolls all session |
| "that purple bar keeps sliding around" | `#ghost motion.path 0 -> 520` | 220ms CSS transition |
| "the teal one lingers when it fades out" | `#fade transition.opacity 220ms` | opacity-only, no rect moves |

It did not start at 5/5. It started at 1/5, and every one of the four failures
was a real defect rather than tuning:

1. **Rarity scored `Infinity`.** A property that is observable but never changes
   divided by zero, so the worst candidate outranked everything.
2. **My ground-truth labels were wrong.** The fixture cycles and starts on step
   0, so click *n* applies step *n+1*. The resolver was right and the labels were
   not, which is the argument for labelled fixtures rather than eyeballing.
3. **Motion was captured and never used.** 66 transition lifecycle events were in
   the recording and no delta was derived from them, so "lingers" had nothing to
   match against.
4. **The alt-click scrolled the page.** Playwright's `click()` scrolls the target
   into view, which scrolled `#code` and erased the stasis the utterance was
   about. Measuring the thing changed the thing.

## The two ideas that do the work

**Rarity beats magnitude.** A UI changes a lot on every interaction. The step
counter changes every time and is never the bug; the property that moved on
exactly one step usually is. Scoring by how *unusual* a change is needs no
vocabulary and no hypothesis about what you are looking for. Words like "left"
and "taller" are worth a little on top, but they are not carrying the result.

**Stasis is a different query.** "the card doesn't move to where we should be
explaining it" is a complaint that nothing happened. No ranking over things that
changed can ever answer it, and the bug that motivated this tool was exactly that
shape: `scrollTop` identical to the pixel across five steps. So an utterance is
first classified motion-or-stasis, and a stasis query ranges over what stayed
constant while its neighbours moved. That needs a universe of *observable*
properties, not just changed ones, which is why the recorder publishes a slow
heartbeat of what exists alongside the stream of what changed.

The classifier gets all nine real-shaped utterances right, including "still
jumps a tad", where "still" means "yet" and not "motionless".

Deixis travels up the ancestor chain: you alt-click the highlighted line, and the
container that failed to scroll is three levels above it.

## Motion is measured, not worked around

The brief listed CSS transitions and layout-derived values as blind spots to
route around. That was wrong, and measurement settled it. Transitions announce
themselves (`transitionrun`/`start`/`end`/`cancel`, each carrying `propertyName`
and `elapsedTime`) and `document.getAnimations()` returns live objects with
`currentTime` and `playState`. Sampling those on rAF turns four subjective
complaints into numbers:

- `settleMs` — interaction to the last frame on which anything actually moved.
  Deliberately geometric: an opacity fade animates but displaces nothing, and
  counting it makes "has it settled?" unanswerable on any page with decoration.
- `cancels` — transitions interrupted mid-flight. This is the mechanism behind
  "it smears" and "it lingers".
- `path` vs `net` — 413px travelled to end up 0px away is maximal waste. The
  ratio separates "it moved 100px" from "it wandered 400px to get there".

## Assertions have to be shown to fail

`node bin/check.mjs` runs every assertion twice: against the broken fixture,
where it must go red, and `?fixed=1`, where it must go green. An assertion that
passes on both is reported `UNFALSIFIABLE` and is worth nothing.

```
assertion              broken   fixed    verdict
focus-visible          FAIL     pass     falsifiable
lens-holds-still       FAIL     pass     falsifiable
motion-settles         pass     pass     UNFALSIFIABLE — never seen red
no-interrupted-motion  FAIL     pass     falsifiable
no-wandering           FAIL     pass     falsifiable

4/5 assertions demonstrated failing for the right reason
```

`motion-settles` is left red-flagged on purpose. The fixture has no slow-settle
bug, so the assertion cannot be demonstrated against it. The correct responses
are to find a page that does have one, or to drop the assertion. Editing the
fixture until the assertion goes red would be inventing a bug to bless a check,
which is the failure this harness exists to catch.

Every assertion is written against a contract ("the line being explained is on
screen") rather than a snapshot ("the lens sits at x=964"). A snapshot check
passes forever, catches nothing, and goes red when the design improves.

Getting to 4/5 required fixing four metric bugs that only the falsification run
could have surfaced:

- **Motion was measured in viewport coordinates.** `getBoundingClientRect()` is
  relative to the viewport, so scrolling a container made every descendant look
  like it moved thousands of pixels. This made `motion-settles` and `no-wandering`
  flip verdicts between runs depending on rAF scheduling: two runs of the same
  command gave 4/5 and 3/5. Motion is now measured by accumulating
  `offsetLeft`/`offsetTop` up the offsetParent chain, which is scroll-invariant.
  Three consecutive runs now agree. A flaky check is worse than no check.
- `settleMs` counted opacity animation, making it unsatisfiable on the fixed page.
- `wander` returned `null` when net displacement was zero, so travelling 413px
  back to the starting point was reported as *no* wandering.
- `path` and `net` disagreed about which journey they described, because only one
  of them re-baselined across a sampling gap.

**Two coordinate frames, two questions.** Motion measurement uses layout
coordinates: "did this actually move?" must not be answerable by scrolling the
page. Utterance resolution keeps viewport coordinates in `lib/tick.js`: "what was
the person looking at?" is a question about the screen, and a thing scrolled out
of view genuinely did move as far as the speaker is concerned. Mixing the two
frames is what made the checks flaky; keeping them separate is deliberate.

## Durability

The prototype this replaces buffered the whole rrweb stream in memory and wrote
it after the loop. The loop exited, `ctx.tracing.stop()` hung against a browser
that was already gone, and the entire stream was lost; only the incrementally
written step log survived, and that log is what carried yesterday's diagnosis.

So `Sink` opens the file append-only and every batch hits disk as it arrives.
There is no write-at-exit path to lose. `kill -9` costs at most the last 250ms.

## Layout

```
lib/engine.mjs   single point of contact with the Playwright/rrweb engine
lib/record.mjs   boot script assembly + the append-only Sink
lib/tick.js      injected: drift-corrected clock, rect sampling, observability
                 heartbeat, alt-click marks with ancestor chain
lib/motion.js    injected: transition lifecycle + rAF motion metrics
lib/deltas.mjs   rrweb stream -> deltas that name elements (node mirror)
lib/resolve.mjs  the join: window, rarity, stasis, deixis, ranking
bin/lab-run.mjs  record the fixture, resolve, score against known answers
bin/check.mjs    walk + assert, with the falsification run
fixtures/lab.html  the labelled fixture; ?fixed=1 removes all three bugs
```

`lib/engine.mjs` exists because Playwright and rrweb still live in
`~/.claude/skills/web-qa/node_modules` and that tree is being folded into this
repo by someone else. When it moves, this is the only file that changes.

## Clock

rrweb stamps `Date.now()`; a transcript counts from the first audio sample. The
recorder emits both clocks together every 2s and the resolver fits
`wall = a*elapsed + b` over every pair rather than trusting one anchor. Measured
on a real recording: 8 pairs, -5.8 ppm drift, 0.49ms residual. A bad fit is
visible in the residual instead of silently skewing every window.

**Audio drift is not yet measured.** The fit above corrects rrweb's own clock.
Aligning the *audio* stream still anchors on ffmpeg start time, and MediaRecorder
start latency is exactly what decision 1 warned about. Measuring it needs a shared
transient (a click track audible to both), and that is not built.

## Not built

- The four CLI verbs. `bin/check.mjs` is `check` with the assertion list inline.
- Audio capture end to end. `startMic()` writes 16k mono via ffmpeg avfoundation
  and a real mic is present, but no session has recorded a human voice yet.
- Transcription. `whisper-cli` is installed; `ggml-small.bin` exists on this
  machine. Nothing calls it.
- The extension path. Note that the CLI route needs no extension and therefore no
  MV3 offscreen document at all; `chrome.offscreen` only becomes necessary for
  pages Playwright cannot drive, such as the user's own logged-in Chrome.
- Anything touching `attention-canvas-viewer`, which was left alone entirely.

## The fixture that is not used, and a provenance mistake

`fixtures/uxmapper-verify.html` is **the fixed build**, and my first reading of
it was wrong in a way worth recording.

I tested provenance by grepping the bundle for identifiers named in the fix plan:
`currentFocusRange` absent, `scrollToFocus` present, therefore pre-fix. That
inference is invalid. The bundle is minified, so `currentFocusRange` being absent
is name mangling, not absent code, and `scrollToFocus` survives in the fixed
build too. **Identifier presence in a minified bundle is not evidence of
provenance in either direction.** Hash the payload or test the behaviour.

Hashing settles it: the `<script type="module">` payload in the fixture and in
`attention-canvas-explain/assets/viewer.html` are byte-identical, 928836 bytes,
sha256 `5d1317d9…`.

Which also dissolves the contradiction I reported. "scrollTop constant to the
pixel" was measured against the pre-fix build, which is not a thing I ever had a
copy of. The 0px lens travel and working scroll I measured are what the fixed
build is supposed to do. Refusing it as ground truth was still right given what I
believed at the time, but the belief was wrong, not the diagnosis.

The fixture stays unused as ground truth for a different and still-valid reason:
a page whose bugs are fixed cannot demonstrate the bugs.

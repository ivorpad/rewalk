# rewalk

Watch a human use a web UI, resolve what they *say* to what the DOM *did*, turn
findings into checks that can be shown to fail.

```
rewalk watch <url>       record a human session: rrweb + voice + pointing
rewalk read <session>    utterances resolved to DOM deltas
rewalk run <walk>        re-walk the same ground scripted, print measurements
rewalk check <walk>      same, with assertions -> exit code
```

Status: the join is proven on real human speech (4/4 top-1) and the CLI verbs
exist in `bin/rewalk.mjs`. Transcription runs on local whisper by default, with
Deepgram available as `REWALK_STT=deepgram`. **See [FINDINGS.md](FINDINGS.md)
for the full record**, including every bug found with the number that found it.
What follows is what was measured, not what is planned.

Nothing needs starting by hand: the entry points bind the fixture server
themselves if nothing is already serving it.

## Testing it yourself

Nothing needs starting by hand. The fixture server binds itself, and every step
below refuses rather than producing a quiet wrong answer.

**1. Check the microphone before anything else.**

```
node bin/mic-check.mjs 6          # talk for six seconds
```

It measures *dynamics*, not level: a fan and a talker can share an RMS, but
speech has gaps between phrases. `READY` means go. Exactly `0.000000` means
macOS is denying microphone access to your terminal (System Settings > Privacy
& Security > Microphone) — it hands out zeroed buffers rather than failing, so
frames arriving proves nothing.

**2. Record yourself using something.**

```
node bin/watch.mjs http://127.0.0.1:51931/hypothesis.html out/mysession
```

Talk while you click. The one non-obvious move: **alt-click the thing you are
complaining about** as you say it. That is the deixis signal, and the mark
carries its ancestor chain, so pointing at a table row credits the container
three levels up that failed to scroll.

Input values are masked by default. `REWALK_UNMASK=1` if you genuinely need the
keystrokes, and it will say so on stdout.

Finish with `touch out/mysession/STOP`.

**3. Read what you said against what the DOM did.**

```
node bin/read.mjs out/mysession
REWALK_STT=deepgram node bin/read.mjs out/mysession    # better boundaries
```

**4. Watch it back.**

```
node bin/replay.mjs out/mysession && open out/mysession/replay.html
```

Click any utterance and the player seeks to 2.5s before you said it, because
people describe a thing after it happens.

**5. Share it.**

```
node bin/video.mjs out/mysession        # -> out/mysession/replay.mp4
```

An mp4 of the whole replay page — player plus the resolved complaints — with
the session's own audio muxed on the wall-clock offset. It frame-steps the
player rather than screen-recording it, so frame k is replay time k/fps
exactly; slow on long sessions, honest about time.

### Pointing it at your own app

Any URL works — `watch` drives its own Chromium, so there is no extension to
install. Two things worth knowing before you pick a target:

- A third-party site can be *diagnosed* but not *fixed*, because there is no
  source to edit. The loop only closes on an app whose repo is on this machine.
- The fixture is scored (`node bin/score.mjs`) because its bugs are known by
  construction and a teleprompter stamps ground truth into the recording. **On a
  real site there is no ground truth and therefore no score** — you get a ranked
  list per complaint and you judge whether it named the right thing. That
  judgement is the experiment.

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

That claim was wrong when it was first written here, and the correction is worth
keeping. `extractMarks` built each mark as `{at: e.timestamp, ...payload}`, and
the payload carried its own `at` in page-elapsed milliseconds, so the spread
silently replaced wall time with elapsed time. Every mark landed decades in the
past. The churn profile buckets deltas by the marks, so no delta fell in any
bucket, every candidate scored equally rare, and rarity was a constant — visible
in the scoring breakdown as `rarity 1` on every line, if anyone had looked. The
first 5/5 was obtained with the signal this section credits switched off.

Fixed and re-measured: rarity now varies (0.405 against 0.712 on the same run)
and the score is 5/5 again. Two other bugs fell out of the same re-measurement —
a lookback of seven seconds let one alt-click attach deixis to every following
utterance, and it won on that; the window is now 2000ms, which is what
push-to-talk actually means.

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

**One coordinate frame for "did it move", and the doctrine that said otherwise
was wrong.** Motion measurement uses layout coordinates: "did this actually
move?" must not be answerable by scrolling the page. An earlier version of this
section defended keeping the rect sampler in `lib/tick.js` on viewport
coordinates as a deliberate second frame for "what was the person looking at?".
Two facts killed that. Nothing ever consumed the frame -- the resolver's
proximity signal is temporal, not spatial, so the doctrine protected a consumer
that did not exist. And on the first real scrolling app it flooded the ranking:
one scroll on ledger's transaction table made every watched element emit
hundreds-of-pixels `rect.y` deltas, and `[aria-label="Close"] rect.y -283 ->
-717` -- pure scroll -- outranked real findings in three separate utterances.
The fixture never scrolled, so the cost was invisible until a real page paid
it. Rects now use the same offsetParent accumulation as `lib/motion.js`;
scrolling stays first-class in its own stream (`rewalk-scroll`), and the
visibility heartbeat keeps viewport boxes because "was it on screen" is
genuinely a screen question.

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

**Audio drift is measured, and not with a sound.** The fit above corrects
rrweb's own clock. The audio stream is a separate problem, and the answer turned
out not to need the beacon: ffmpeg's `-progress` pipe reports `out_time_us`
several times a second, and reading each line at a known wall time pairs a
position in the audio with a position on the system clock. That gives the slope
over the whole session rather than over a 35s beacon train, and it works when
the microphone is nowhere near the speakers.

Measured on a real 7.4-minute session: sample 0 at +571ms, drift 5.1ppm,
residual 31.89ms over 1750 ticks. The capture latency it replaces is not a
constant to guess at -- 418, 505, 1108, 1349, 1452 and 1879ms across six runs.

What the progress clock cannot see is its own intercept bias: the reports are
late by however long ffmpeg takes to encode and flush one, and that has been
asserted to be small and never checked. The beacon is the only instrument that
could check it, which is now the main reason to want the acoustic path working
rather than the alignment mechanism itself. `bin/beacon-smoke.mjs` prints the
comparison when the microphone can hear the speakers.

## Recording a person

`bin/watch.mjs` records a human using a page: rrweb, motion, marks and the
microphone, all appended to disk as they arrive.

**The microphone is whichever one the person chose.** The first version
hardcoded avfoundation index `:4`. That is wrong twice: indices shift as
hardware comes and goes, and the device someone expects recorded is whichever
they picked in System Settings, which no index can tell you.
`lib/mac/default-input.swift` asks CoreAudio, and with `--watch` registers a
property listener so a mid-session change is noticed when it happens rather than
a poll interval later. `lib/mic.mjs` follows it: a device change closes the
current audio segment and opens a new one, each with its own clock fit, with the
boundary recorded rather than smoothed over.

**Check the microphone hears a person before recording, not after.** A three
minute session was recorded, transcribed, and only then found to contain no
speech at all: 199 seconds at a dead flat 0.30 RMS, which Whisper labelled
`[Music]` end to end. `bin/mic-check.mjs` measures *dynamics*, not level — a
constant hiss and a talker can share an RMS, but speech has gaps between phrases
and a fan does not. Validated against the real recordings: the failed session
scores 1.6x quiet-to-loud, the working microphone 9.7x, a live session 17.6x.

Exactly `0.000000` from an input is macOS denying microphone permission to the
terminal, not a bug. It hands out zeroed buffers rather than failing, so frames
arriving proves nothing; only a non-zero sample does.

## Reading a session back

`bin/read.mjs` transcribes locally with `whisper-cli`, converts audio time to
wall time with the measured clock, and runs each utterance through the join.

**Utterance boundaries come from the waveform, not from the transcript.**
Whisper's own segments are 10 seconds wide, three times wider than the window
the join searches. Asking for word timestamps (`-ml 1 -sow`) does not help
either: measured, the gap between consecutive words is 0ms at the 90th
percentile, because it stretches each word to fill the span it was decoded in.
There are no pauses in those timings to split on, and 89 words collapsed into 2
utterances. Energy-based segmentation on the audio gives 9, and a real start
time for each.

Run end to end on a real recording: 701 events, 591 deltas, 27 interactions,
70s of speech, audio clock residual 5.64ms over 317 ticks, 89 words to 9
utterances.

That figure is now scored rather than described. `fixtures/hypothesis.html`
teleprompts a person through four complaints about bugs known by construction
and stamps every cue into the recording, so `node bin/score.mjs out/session5`
reports **4/4 top-1 on real human speech** -- including the stasis case, which
no ranking over things that changed could have answered.

## Two engines, and which one to believe

Whisper is the default: local, no key, no network, 4s to transcribe 120s on
Metal. Deepgram is `REWALK_STT=deepgram`, with the key read from
`~/.config/rewalk/deepgram.key` at the moment of use rather than from the
environment, so it is not inherited by ffmpeg, chromium or whisper-cli.

Audio can be cut two ways. `vad` finds regions by energy in the waveform and
transcribes each on its own, so the text and its start time come from the same
place. `words` makes one call for the whole file and cuts on the word times
Deepgram returns. Scored against the same recording, all three combinations
report 4/4 top-1 -- the join is carried by rarity and is not sensitive enough to
separate transcripts. `node bin/stt-compare.mjs` therefore measures the
transcript directly, against the sentences the teleprompter asked for:

```
whisper/vad     WER  7.5%   4 utterances
deepgram/vad    WER  7.5%   4 utterances
deepgram/words  WER  5.0%   4 utterances
```

40 words of ground truth and a one-word difference: that ranked the options and
settled nothing. Whisper heard "roll" for *row*; Deepgram heard "car" for
*card*. One error each.

A second session settled it, because the speaker ran two complaints together
with no pause the energy segmenter could see:

```
                 WER     score
whisper/vad     42.5%     3/4
deepgram/vad    47.5%     3/4
deepgram/words  12.5%     4/4
```

**Note which variable moved.** On identical regions Deepgram's acoustic model is
no better than whisper's -- it is slightly worse. All of the gain is
segmentation. The VAD merged cue 2 into cue 1's region, so cue 2 was paired with
cue 3's sentence and its own text was never available at all: an empty
hypothesis, and a MISS on a join that had nothing wrong with it. Deepgram's word
times put the boundary in the right place and the same join scores it 4/4.

So Deepgram now defaults to `words` and whisper to `vad`. The reason to reach
for Deepgram is not that it hears better; it is that it reports where the
silences are, and the boundaries are what the join is sensitive to.

What it does settle is whether the VAD can go. **The percentile test is the
wrong instrument**, and it was the first one written here: Deepgram's word gaps
are 0ms at both p50 and p90, which reads exactly like whisper's failure. But
words inside a fluent phrase genuinely abut, so those percentiles are 0ms for
any engine reporting honest times -- only 3 of 39 gaps here are sentence
boundaries, which puts every percentile below p92 at zero. The test that means
something is how many gaps clear the split threshold: 3, giving 4 utterances
against the 4 the waveform found independently. Whisper's failure was one gap
over threshold across 89 words. So the word times are usable and the VAD is the
fallback rather than the path -- and it stays in the tree.

WER also had to be fixed before it said anything. The prompt window runs past
the cue on purpose, because people talk over the end of it, so the text carries
the first words of the next sentence; charging those as insertions measured the
harness rather than the engine. Every engine scored ~30% and they were
indistinguishable. Scoring the best prefix of what was said drops it to 5-7.5%.

## The capture was losing a tenth of its samples

ffmpeg's `out_time` advances with the wall clock, not with samples written, so
when the device under-delivers the file falls behind while the progress fit
stays internally consistent and reports a tight residual. Every position then
maps to a wall time that is too early by a margin that grows all session. It
does not read as a bug: it reads as a person anticipating the prompt.

FINDINGS.md named the pre-flight audition as the first suspect. Measured, that
is wrong -- a cold capture with no audition loses just as much, and the settle
delay the hypothesis implied makes it worse:

```
cold, no audition        12.1% lost
after an audition        10.7%
audition + 750ms settle  20.1%
cold, aresample=async     0.0%
```

The cause is the resampler. `aresample=async=1` fills the gap instead of
writing short, which keeps audio position and elapsed time the same quantity.
Rate and channel count are not involved: native 48k stereo loses 11.3%.
Confirmed on a real session afterwards -- 443.58s of capture into a file
holding 443.55s, 0.00%. `node probes/capture-drop.mjs` reproduces it.

Found while verifying that: the raw `.s16le` fallback had always been written
at the device's native 48kHz stereo, because `-ac`/`-ar` are per-output options
and the single copy before the first `-map` applied only to the wav. Every
recording in this repo shows the giveaway 6.00x size ratio. The file the
durability story rests on decoded six times too slow, and nothing noticed
because nothing had ever had to fall back to it.

## Audio alignment

The clock fit above corrects rrweb's own clock. Aligning the *audio* stream is a
separate problem: the file starts whenever the capture device delivered its first
sample, which is not when it was asked, and the sound card's clock then drifts
against the system clock on top of that.

The fix is a shared transient. The page plays a short 1970Hz tone through the
speakers, stamps the wall clock for the instant it is scheduled to sound, and the
same microphone that records the voice picks it up. Two lists of times for the
same physical events give offset *and* slope. `lib/beacon.js` emits,
`lib/align.mjs` detects (Goertzel at the beacon frequency, scored as tone power
over total power so a loud room and a distant mic both work).

`node bin/align-test.mjs` synthesises audio with a known start offset (137ms
late) and known drift (320ppm), then checks the fit recovers it:

```
budget: alignment error <= 50ms, against the join's 3500ms window

quiet room       ok    found 8/8, paired 8   worst alignment error  4.1ms
speech over it   ok    found 8/8, paired 8   worst alignment error 24.4ms
noisy + speech   ok    found 4/8, paired 4   worst alignment error 17.3ms

anchoring on capture start alone is off by 763ms (22% of the window)
```

The budget is derived rather than picked: what matters is not ppm but how far
out of step the two timelines are against the +-3500ms window the join searches.
50ms is 1.4% of that and cannot change which delta wins.

Two findings worth keeping:

**Evenly spaced beacons alias, and fail confidently.** With a uniform 5s train
and 3 of 8 beacons detected, an offset shifted by exactly one whole interval
explains the survivors just as well. The fit reported the start time 5009ms late
with a 0.77ms residual — a wrong answer that looks like a very good one. The
spacing is now jittered by a deterministic +-900ms so the pattern is unique.
A clean residual is not evidence of a correct fit when the pattern is periodic.

**Pair by consensus, not by order.** Matching the nth detection to the nth stamp
inverts the whole fit the moment one beacon is missed, and a missed beacon in a
noisy room is the expected case. Each candidate pair now proposes an offset and
the offset explaining the most detections wins. This is what took the noisy case
from -338578ppm to usable.

Limits, stated plainly: this is **synthetic audio**. No microphone has recorded a
beacon yet, so the acoustic path (speakers loud enough, mic close enough, room
not swallowing 1970Hz) is untested. Drift is also poorly estimated over a 35s
span — one case recovered 26ppm against a true 320ppm — and alignment stays
accurate only because every utterance falls *between* beacons. Extrapolating
beyond the beacon span is not safe, which is an argument for beaconing for the
whole session rather than only at the start.

## Not built

- `bin/check.mjs` still carries its assertion list inline rather than folding
  into the runners. Its falsification behaviour is the part that must survive
  any merge.
- **No microphone has yet heard a beacon, and we now know why.** The page
  emitted 4 tones and the mic heard 0 — because the system output was on
  headphones, confirmed by the operator afterwards. Nothing went into the room,
  so nothing could come back. That is a routing result, not a verdict on 1970Hz:
  the acoustic path remains **untested rather than failed**, and the distinction
  matters, because "we measured it and it does not work" and "we never actually
  measured it" lead to opposite decisions.

  To close it, set the system output to a speaker the microphone can hear and
  run `node bin/beacon-smoke.mjs`. The CLI does not depend on the result:
  alignment comes from ffmpeg's progress reports, which need no sound at all.
  The beacon's remaining job is to measure the one thing the progress clock
  cannot see about itself — the intercept bias in its own reports.
- The `motion-settles` assertion is honestly flagged UNFALSIFIABLE. The fixture
  has no slow-settle bug and inventing one to bless the check is the failure the
  harness exists to catch.
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

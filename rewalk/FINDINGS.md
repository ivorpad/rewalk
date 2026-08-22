# rewalk: findings

Written as a handoff. The join is proven; transcription is now the weak link,
and the next piece of work is Deepgram. Everything below was measured on this
machine, and every number is from a real run rather than an estimate.

## Where it stands

**4/4 top-1 on real human speech**, scored against ground truth stamped into the
recording. A person spoke four complaints at a fixture whose bugs are known by
construction, and each one resolved to the right node and property at rank 1.

| said (transcribed) | resolved to | rank |
|---|---|---|
| "Well, the card is jumped over to the left." | `#insight rect.x 1192 -> 1039` | 1 |
| "And now it got way taller than it was." | `#insight rect.height 98 -> 199` | 1 |
| "The highlighted roll never scrolls into view, it just stays where it was." | `#results scrollTop` **held**, changed in 0/7 steps | 1 |
| "that little chip keeps sliding out and snapping back." | `#chip transition.left cancel -> 95ms` | 1 |

Reproduce with `node bin/score.mjs out/session5`.

Two earlier harnesses still pass: the synthetic labelled fixture at 5/5
(`bin/lab-run.mjs`), and 4/5 assertions demonstrated falsifiable
(`bin/check.mjs`, with the fifth honestly flagged as undemonstrable).

## What the join actually does

Four signals, in rough order of how much work they do.

**Rarity.** A UI changes constantly, and the step counter changes every time
without ever being the bug. Scoring by how *unusual* a change is, rather than
how large, needs no vocabulary and no hypothesis formed in advance. This was the
original argument for the tool: a hand-picked probe encodes the theory you had
before you knew the bug.

**Stasis is a separate query.** "the highlighted row never scrolls into view" is
a complaint that nothing happened, and no ranking over things that *changed* can
answer it. Utterances are classified motion-or-stasis first, and a stasis query
ranges over what stayed constant while neighbours moved. This needs a universe of
*observable* properties, not just changed ones, because a `scrollTop` that stays
0 all session appears in no stream of changes. The recorder publishes a slow
heartbeat of what exists alongside the stream of what changed.

The classifier gets all nine real utterance shapes right including "still jumps
a tad", where "still" means "yet" and not "motionless".

**Motion is measured, not inferred.** Transitions announce themselves
(`transitionrun`/`start`/`end`/`cancel` with `propertyName` and `elapsedTime`)
and `document.getAnimations()` returns live objects. Sampling on rAF turns
subjective complaints into numbers: `settleMs`, `cancels`, and `path` against
`net` displacement. A cancel is the mechanism behind "it smears" or "it lingers".

**Deixis.** Alt-click as push-to-talk. The mark carries its ancestor chain, so
pointing at a table row credits the container that failed to scroll three levels
up.

## Audio capture: everything learned the hard way

This is the part the Deepgram work inherits, and most of it is provider-agnostic.

### The clock is not what you think it is

**ffmpeg's `out_time` advances with the wall clock, not with samples written.**
When the capture device under-delivers, `out_time` keeps climbing while the file
falls behind. The progress-based clock fit stays internally consistent and
reports a tight residual (11.67ms) while mapping every position in the file to a
wall time that is too early.

Measured: ffmpeg reported 67.8s processed into a file holding 60.67s. **10.5% of
samples lost.** The four utterances landed 2.1s, 2.9s, 3.8s and 4.2s before the
prompts that caused them. The first score was 0/3, with every cue paired to the
*next* cue's sentence.

A constant offset would have been obvious. A drift that accumulates reads as a
person anticipating the prompt, which is a plausible enough story that it nearly
got written down as a finding about human behaviour.

`clockOf()` now reconciles the tick fit against the real duration of the file and
stretches the mapping, reporting `dropRate` so the loss stays visible. **That
correction makes an existing recording readable. It does not fix the capture,
which is still losing 10.5%.** Root cause is not established. A settle delay
after the pre-flight audition is the first thing to try, since the audition holds
the same device four seconds before the real capture opens.

**This matters for Deepgram.** Streaming ASR returns word timings relative to the
audio it received. If the capture drops samples, that timeline has exactly the
same defect, and it will be harder to spot because there is no file to compare
against. Keep a reconciliation: compare bytes sent to wall time elapsed.

### Capture latency is real and varies per run

Wall time of audio sample 0, relative to when ffmpeg was asked to start, across
five runs: **418ms, 505ms, 1108ms, 1349ms, 1452ms, 1879ms**. Anchoring on
"capture start" bakes whichever of these you got into every window.

Drift measured 16 to 27ppm on long captures, and much noisier on short ones
(324ppm over 20s, which was a poorly conditioned fit rather than a real number).
Estimate drift over the longest span available.

### The microphone must be the one the user chose

The first version hardcoded avfoundation index `:4`. In the successful session
the HyperX resolved to **`:3`**, having been `:4` in every earlier run. Indices
shift as hardware appears and disappears, and the name lookup absorbed it
silently. A hardcoded index would have recorded the wrong device.

`lib/mac/default-input.swift` asks CoreAudio for the default input and, with
`--watch`, registers a property listener so a mid-session change is noticed when
it happens. `lib/mic.mjs` follows it: a device change closes the current audio
segment and opens a new one, each with its own clock fit, boundary recorded
rather than smoothed over.

`~/src/tries/2026-03-16-aemal-vibestage-desktop` was checked for reusable code
and has none: it relies on `AVAudioEngine.inputNode` implicitly following the
default and never asks what the device is, and has no change detection. It did
confirm one thing worth repeating, from its session-health code: *zeroed buffers
are what macOS delivers for a muted or wrongly-selected input, so frames arriving
proves nothing, only a non-zero sample does.*

### Two sessions were lost to audio nobody checked

199s and 120s of a person talking, both transcribed as `[Music]` end to end. RMS
sat flat at 0.30 for the whole recording where a good session dips to 0.010
between phrases. Something continuous at speech level was in front of the mic.

The gate for this now runs inside `Mic.start()` before the browser opens and
refuses the session. It gates on **loud AND flat**: a quiet room is fine, and a
high floor that never dips is not, because the gaps between phrases are where
speech is legible. Validated against the real recordings: failed sessions score
1.6x and 1.9x quiet-to-loud, working ones 9.7x, 13.2x, 17.6x, 113x.

A fan-spinning-up hypothesis was tested and disproven: 185s unattended with the
browser running held the floor at 0.010 to 0.027.

**Exactly `0.000000` from an input is macOS denying microphone permission to the
terminal**, not a bug. It hands out zeroed buffers rather than failing.

## Transcription: what Deepgram has to beat

Local `whisper-cli` with `ggml-small.bin`. Good enough to prove the join, not
good enough to ship.

Real errors from the sessions: "the Paris Twitching" for *that bar is twitching*,
"T-Line" for *teal line*, "the car" for *the card*, "roll" for *row*. The join
survived "roll" because rarity and the stasis classifier carried it, but a
noun-matching signal cannot work on text like that.

**Whisper's word timestamps are unusable for segmentation.** With `-ml 1 -sow`
the gap between consecutive words is **0ms at the 90th percentile**, because each
word is stretched to fill its decode span. There are no pauses left to cut on: 89
words collapsed into 2 utterances, merged two complaints into one line, and cut a
third mid-word. Its own segments are 10s wide, three times the window the join
searches.

Current workaround is in `lib/utterances.mjs`: segment on energy in the waveform,
then transcribe each region separately, so text and start time come from the same
source. **Deepgram should make this unnecessary** since it returns real
word-level start and end times. Verify that against the same fixture before
throwing the VAD away, and keep the energy segmentation as a fallback.

Whisper is CPU-cheap here (4s for 120s of audio on Metal), so local stays viable
as the privacy-preserving default. The Deepgram key is at
`~/.config/rewalk/deepgram.key`, 0600 in a 0700 directory, and has not been read
or used. **It must not reach the extension bundle**: terminate the connection
host-side.

## Every bug found, with the number that found it

| bug | symptom | how it was caught |
|---|---|---|
| `extractMarks` overwrote wall time with page-elapsed time | every mark landed decades in the past; churn buckets empty; **rarity was a constant** on every candidate | printed as `rarity 1` on every line of every run; only noticed when a real session showed "0 interactions in window" with 27 interactions |
| deixis lookback of 7s | one alt-click scored `deixis 1` on a complaint 4s later and won on it | labelled fixture dropped to 4/5 |
| ffmpeg `out_time` vs samples written | utterances 2.1/2.9/3.8/4.2s early, growing | 0/3 with every cue paired to the next cue's line |
| VAD threshold could exceed the loudest frame | 2.5x the 10th percentile came to 0.553 against a max of 0.527; **zero utterances** rather than "no speech here" | a bad recording produced an empty result instead of a diagnosis |
| motion measured in viewport coordinates | scrolling a container made every descendant appear to move thousands of px; checks flipped 4/5 and 3/5 between runs | three runs of the same command disagreeing |
| `wander` returned null at zero net displacement | 413px travelled back to the start reported as *no* wandering | the assertion silently ceased to exist |
| `settleMs` counted opacity animation | unsatisfiable on any page with decoration | red on the fixed variant too |
| uniform beacon spacing aliases | start time recovered **5009ms late with a 0.77ms residual** | a clean residual on a periodic pattern is not evidence |
| fixture grid item `min-height:auto` | the document scrolled instead of the panel, so the scroll-stasis bug was untestable | `#results` absent from the scrollable list |
| cue patterns double-escaped | `rect\\.x` asked for a literal backslash | had never run until the first session reached the scorer |

Two of these produced **confidently wrong output with a healthy-looking metric**:
the beacon aliasing (tight residual, wrong answer) and the clock drift (tight
residual, every utterance mis-mapped). Neither would have been caught by
inspection.

## Assertions must be shown to fail

`bin/check.mjs` runs every assertion twice: against the broken fixture where it
must go red, and `?fixed=1` where it must go green. Anything passing both is
reported `UNFALSIFIABLE` and is worth nothing.

Currently 4/5. `motion-settles` is left flagged on purpose: the fixture has no
slow-settle bug, so the assertion cannot be demonstrated. Editing the fixture
until it goes red would be inventing a bug to bless a check, which is the failure
the harness exists to catch.

Assertions are written against contracts ("the line being explained is on
screen") rather than snapshots ("the lens sits at x=964"). A snapshot check
passes forever, catches nothing, and goes red when the design improves.

## What is not built

- **The four CLI verbs.** `watch` and `read` exist as scripts; `run` and `check`
  should fold into `skill/scripts/qa.mjs` rather than forking a second
  scripted-walk runner. That merge is unblocked and not done.
- **Assertion generation from a session.** Sessions do not yet end by proposing
  checks, which was decision 6 in the original brief and is the step that turns a
  bug report into a regression test.
- **The extension path.** The CLI route needs no extension and no MV3 offscreen
  document. `chrome.offscreen` is only required for pages Playwright cannot
  drive, meaning the user's own logged-in Chrome. That is a real case and it is
  not first.
- **The acoustic beacon** works against synthetic audio (3/3 within a 50ms
  budget) but no microphone has ever heard one. It is off by default
  (`REWALK_BEACON=1`) because it needs the mic to hear the speakers, which fails
  when the mic is not near the machine. `bin/beacon-smoke.mjs` was extended to
  measure the bias between the acoustic anchor and the progress clock, which is
  the one way to check the number the CLI actually relies on.
- **The 10.5% sample loss.** Corrected for, not fixed.

## Running things

```bash
# serve the fixtures
(cd fixtures && python3 -m http.server 51931)

node bin/mic-check.mjs 6                    # is the mic hearing a person?
node bin/watch.mjs <url> out/<name>         # record; touch out/<name>/STOP to finish
node bin/read.mjs out/<name>                # utterances resolved to deltas
node bin/score.mjs out/<name>               # scored, needs the hypothesis fixture

node bin/lab-run.mjs                        # labelled synthetic fixture, 5/5
node bin/check.mjs                          # falsification run, 4/5
node bin/align-test.mjs                     # beacon detector against known truth, 3/3
```

`fixtures/hypothesis.html` is the scored fixture: a realistic analytics app with
four known bugs and a teleprompter that stamps every cue into the recording with
the node and property it is about. That is what makes a session an experiment
rather than a demo. `?fixed=1` on `lab.html` removes its bugs, for falsification.

The teleprompter is excluded from the join by `isInstrument()`, because it
rewrites itself every few seconds and would otherwise be the rarest, most recent
change in every window.

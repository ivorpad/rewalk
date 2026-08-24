# Sharp edges

Every entry here was hit for real. Find your symptom, read the cause, do the fix.

## The capture is digitally silent — peak exactly 0.000000

macOS is denying microphone access to the terminal. It hands out zeroed
buffers rather than failing, so ffmpeg runs fine, the file grows, and every
sample is zero (measured: 43,162 samples, zero non-zero). Frames arriving
proves nothing; only a non-zero sample does.

Fix: System Settings → Privacy & Security → Microphone → enable the terminal
app, then **restart the terminal**. The audition gate refuses the session
before the browser opens, so nothing is wasted.

## Audition refuses: "loud and unvarying" / transcript is [Music] end to end

A continuous sound source at speech level is in front of the mic — a music
app, a fan feed, a stream. Two sessions (199s and 120s of real talking) were
lost this way: RMS flat at 0.30 where speech dips to 0.010 between phrases.
The gate signature is loud AND flat (dynamic range < 3x; good sessions measure
9.7x–113x). A quiet room passes — quiet is fine, flat is not.

Fix: silence the source. `REWALK_SKIP_AUDITION=1` records anyway, and the
recording will very likely transcribe as nothing.

## Wrong device recorded / device errors after unplugging something

avfoundation indices shift when hardware comes and goes — the same HyperX mic
was `:4`, then `:3`, then gone (default fell back to the MacBook mic at `:2`)
within one week. Never hardcode an index. `defaultMicSpec()` resolves the
CoreAudio default input by name at the moment of use; a mid-session device
change closes the segment and opens a new one with its own clock.

Override only deliberately: `REWALK_MIC=:N`.

## Session has audio but 0 utterances resolve / 0 interactions

Check clicks before blaming the pipeline. One 444-second recording contained a
person waiting and zero clicks — the browser window was never focused. On the
guided fixture, look for the `rewalk-cue` events: `ready:1` present with no
`say-start` means the instrument armed and nobody clicked; no `ready` at all
means the instrument is broken (or the page is not the fixture — cues only
exist there). The HUD (bottom-right of the recorded window) now shows
mic state live; "mic hears nothing" going red mid-session is a real signal,
not decoration.

## Two complaints came back as one utterance, or one complaint's text vanished

The speaker didn't pause and the energy segmenter merged the regions. Measured
cost: one merged region made the scorer pair a cue with the NEXT cue's
sentence — the complaint's own text was unavailable in any window (WER 42.5%
vad vs 12.5% words on the same audio; 3/4 vs 4/4). Deepgram defaults to
cutting on its own word times (`words`), which recovers this; whisper cannot
(its word gaps are 0ms at p90). If stuck on whisper, tell the speaker to leave
half a second between complaints.

## replay.html opens but the player is blank white

The event stream fed to rrweb-player is missing its Meta event (type 4, holds
the viewport size). rrweb wants `[Meta, FullSnapshot, ...]`; slicing from the
FullSnapshot drops Meta and the player builds the entire DOM and paints
nothing. `bin/replay.mjs` slices from Meta now — if you see this, the stream
was cut by something else.

Verify replays by pixels (screenshot), never by node counts: the blank player
contained 1,171 correctly-built nodes.

## Fixtures look stale or wrong

The fixture server (`lib/serve.mjs`) self-binds its port but **reuses anything
already listening** — including a hand-started server from a previous session
serving an old checkout. `lsof -nP -iTCP:51931` to see who owns it.
`REWALK_PORT=NNNNN` forces a fresh one.

## Speech you know happened is missing from the score

The scorer pairs speech to cue windows (cue start −500ms to say-end +3000ms).
Anything said outside every window — trailing chatter, thinking aloud after
the run — is silently dropped, not mis-assigned. It still appears in
`resolved.json` and the replay; it just carries no ground truth.

## Utterances land progressively earlier than the prompts that caused them

That is the sample-loss signature: the capture under-delivers, ffmpeg's
out_time keeps climbing anyway, and every audio position maps to a wall time
too early by a growing margin (measured: 2.1/2.9/3.8/4.2s across one session —
it reads as the person anticipating, which is why it nearly shipped as a
finding about humans). Fixed with `aresample=async=1` (10.8–18.5% loss → 0.00%).
`clockOf()` still reconciles against the file and reports `dropRate`; a
non-zero dropRate in a new session means the capture regressed — fix the
capture, don't trust the stretch.

## Typed values show as ●●●● in the replay

Not a bug. `watch` masks all input values by default so a login password never
lands in the stream. `REWALK_UNMASK=1` records values in the clear and says so
on stdout.

## Reading OLD sessions: the raw .s16le decodes 6x too slow

Recordings made before 2026-08-24 wrote the `.s16le` durability fallback at
the device's native 48kHz stereo while everything assumed 16k mono — the
giveaway is a raw file exactly 6.00x the wav's data size. The wav is fine; if
you must read the old raw, treat it as 48k stereo.

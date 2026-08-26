# rewalk-mic — the bundled microphone capturer

Exists because the Chrome-spawned native host cannot record the microphone: a
bare `node` process has no Info.plist for macOS to attribute a TCC grant to, so
it receives zeroed buffers (measured: peak 0.000000, no prompt). A bundle with
`NSMicrophoneUsageDescription` can be prompted for and granted. The pattern is
from `~/src/tries/2026-03-16-aemal-vibestage-desktop` (CopilotAudio.app), pared
to mic-only via AVAudioEngine — no ScreenCaptureKit, so no Screen Recording
permission, which a voice recorder should not demand.

Output: a 16k mono WAV (rewalk's format), header fixed up on SIGINT/SIGTERM.
Clock: (audioMs, wall) ticks to stderr every 250ms — the same signal ffmpeg's
`-progress` gave the CLI, so `fitProgressClock` works unchanged.

## Build

    swiftc -O -o rewalk-mic.app/Contents/MacOS/rewalk-mic rewalk-mic-src/rewalk-mic.swift
    codesign --force --sign "rewalk signing" rewalk-mic.app   # stable identity (make-signing-identity.sh); ad-hoc (-) loses the TCC grant on every rebuild

Ad-hoc signing (`- `) is enough for a stable local TCC identity. The built app
and binary are gitignored; this source and the Info.plist are committed.

## Verified

Run as a bundle on this machine: peak 0.145, 62204/62266 non-zero samples over
3.89s — a real mic grant, where the bare host got 0.000000.

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

    sh lib/mac/build-apps.sh

That creates the per-machine `rewalk signing` identity if needed, compiles
both apps, and signs them. Do not distribute the signed binaries — TCC binds
the mic grant to the identity on *this* machine.

    swiftc -O -o rewalk-mic.app/Contents/MacOS/rewalk-mic rewalk-mic-src/rewalk-mic.swift
    codesign --force --sign "rewalk signing" rewalk-mic.app   # same as build-apps.sh

The built binary is gitignored; this source and Info.plist are committed.

## Verified

Run as a bundle on this machine: peak 0.145, 62204/62266 non-zero samples over
3.89s — a real mic grant, where the bare host got 0.000000.

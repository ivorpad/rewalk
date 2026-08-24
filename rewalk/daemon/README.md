# The voice daemon — button-only recording

With this installed, the rewalk toolbar button is the whole interface: click
to start (DOM in Chrome, voice from the daemon, HUD level meter live), click
to stop, and a macOS notification opens the finished replay. No terminal.

## How it fits

The browser cannot own the microphone on macOS — TCC never attributes a
capturer inside Chrome's process tree, so it gets no prompt and zeroed
buffers (measured twice; see HANDOFF.md). A process the user launched must
hold the grant. `rewalk session` held it from a terminal; this daemon holds
it from login.

The protocol is three files in `out/`, no socket:

1. Button click → the extension host starts. If no `rewalk session` companion
   is attached, the host writes `out/.rewalk-voice` = `{dir, startedWall,
   active}` naming its session directory.
2. The daemon polls that file (250ms). On a fresh request it records voice
   into the same directory via lib/voice.mjs — the identical artifacts the
   companion writes (audio.1.wav, utterances.ndjson streamed live through
   Deepgram, audio-meta.json).
3. Button click again → Chrome closes the native port, the host's last act is
   writing `session.json` (`via:'extension'`) — the same stop signal the
   companion listens for. The daemon stops, merges, reads, builds
   replay.html (lib/finish.mjs, shared with `rewalk session`) and posts a
   notification whose click opens it (terminal-notifier if installed,
   osascript announce otherwise).

The daemon auditions the mic bundle once at startup, so per-session starts
skip the 3s gate and the first words after the click are not lost. If the
startup audition fails (device busy at login) it stays up and gates each
session individually instead — a KeepAlive agent must not die on a transient.

## Install (a human step, knowingly)

```
sh daemon/install.sh      # LaunchAgent com.rewalk.voiced, runs at login
sh daemon/uninstall.sh
```

Testing without launchd: `node bin/daemon.mjs` in a terminal does the same
job (a pid lockfile in out/ keeps two instances from double-capturing).

Log: `~/.config/rewalk/daemon.log`.

## The launchd TCC lesson (measured 2026-08-24)

A LaunchAgent whose program is bare node gets digitally-silent capture, even
though the SAME rewalk-mic.app records real audio when launched via
LaunchServices. TCC resolves responsibility to the launchd job, and a
bundleless job has no Info.plist to prompt against — the native-host failure
mode, one level up. "The bundle is its own responsible process" was wrong
here: a child bundle does NOT carry its own responsibility; it rolls up.

So the job's program lives inside `lib/mac/rewalk-voiced.app` — a signed
wrapper (source in `lib/mac/rewalk-voiced-src/`) that spawns node as a child
(spawn, not exec: an exec would swap the process image and lose the identity)
and forwards signals. install.sh builds it if missing and points the plist at
its inner binary. With the wrapper: `daemon up; mic auditioned ok` under
launchd, measured on this machine.

## Verified, and not

- Verified live, terminal-launched: request pickup, live Deepgram streaming,
  stop on host finalization, merge/read/replay, notification.
- Verified live, launchd-launched via rewalk-voiced.app: startup audition
  passes with real audio (bare-node job measured digitally silent first).
- NOT yet: a full button-only paired recording with a human talking.

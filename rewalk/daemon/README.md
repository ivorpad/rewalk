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

## Verified, and not

- Verified live (this repo, terminal-launched daemon): request pickup, live
  Deepgram streaming, stop on host finalization, merge/read/replay,
  notification.
- NOT yet verified: that rewalk-mic.app receives its TCC grant when its
  ancestor is launchd rather than a terminal. The bundle is its own
  responsible process, which is the whole point of it, so it should — but
  "should" has been wrong about TCC before. First `sh daemon/install.sh` on a
  machine answers it; if capture is digitally silent in the log, that is the
  cause, and the fix is granting rewalk-mic in System Settings → Privacy →
  Microphone.

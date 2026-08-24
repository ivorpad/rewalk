#!/bin/sh
# Native messaging host wrapper for the rewalk Risk-3 TCC probe.
# Chrome spawns this with a minimal environment; give node a PATH that finds
# ffmpeg (/opt/homebrew/bin) and the CoreAudio helper's build tools.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec /opt/homebrew/bin/node "/Users/ivor/src/tries/2026-08-22-rewalk/rewalk/ext-probes/native-host/capture-host.mjs" "$@"

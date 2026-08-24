#!/bin/sh
# Install the native messaging host so Chrome will spawn it for the extension.
# This is the one step a person must run knowingly: it lets a browser extension
# start a microphone-recording process on this machine. Read it before running.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
WRAP="$HERE/rewalk-host.sh"
chmod +x "$WRAP" "$HERE/rewalk-host.mjs"
mkdir -p "$DEST"
sed "s#HOST_WRAPPER_PATH#$WRAP#" "$HERE/com.rewalk.host.json" > "$DEST/com.rewalk.host.json"
echo "installed: $DEST/com.rewalk.host.json"
echo "wrapper:   $WRAP"
echo
echo "Next: load the unpacked extension at $HERE/.. via chrome://extensions"
echo "(Developer mode on -> Load unpacked -> select the chrome-ext directory)."
echo "The pinned key keeps its id as $(cat "$HERE/.ext_id")."

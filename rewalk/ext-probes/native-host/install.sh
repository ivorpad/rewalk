#!/bin/sh
# install.sh — the two steps the agent's safety classifier blocked. Installing
# a native messaging host that captures the microphone into the browser's
# config is exactly what that classifier guards; run this yourself, knowingly.
#
# It (1) makes the host wrapper executable and (2) copies the host manifest
# into the NativeMessagingHosts dir for real Chrome, Chrome for Testing (what
# Playwright launches), and Chromium. Then run: node launch-ext.mjs
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

chmod +x "$HERE/capture-host.sh"
echo "chmod +x capture-host.sh"

for DIR in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"; do
  mkdir -p "$DIR"
  cp "$HERE/com.rewalk.probe.json" "$DIR/com.rewalk.probe.json"
  echo "installed -> $DIR/com.rewalk.probe.json"
done

echo
echo "Now run:  node \"$HERE/launch-ext.mjs\""
echo "To remove later:  sh \"$HERE/uninstall.sh\""

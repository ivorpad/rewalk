#!/bin/sh
# uninstall.sh — remove the probe host manifests from every browser dir.
set -eu
for DIR in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"; do
  rm -f "$DIR/com.rewalk.probe.json" && echo "removed -> $DIR/com.rewalk.probe.json"
done

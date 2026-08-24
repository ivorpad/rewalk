#!/bin/sh
# Install the rewalk voice daemon as a LaunchAgent, running at login.
# This is the step to run knowingly: it keeps a process on this machine that
# will record the microphone whenever the rewalk Chrome extension asks it to.
# Read bin/daemon.mjs before running.
#
# Same subtlety as the native host: launchd starts agents with a minimal PATH
# and no shell profile, so node's absolute path is resolved now and baked into
# the plist. The daemon itself prepends Homebrew's dir for ffprobe and
# terminal-notifier.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
NODE="$(command -v node)"
[ -x "$NODE" ] || { echo "node not found on PATH; install node first"; exit 1; }
[ -x "$REPO/lib/mac/rewalk-mic.app/Contents/MacOS/rewalk-mic" ] || {
  echo "rewalk-mic.app is not built; see lib/mac/rewalk-mic-src/README.md"; exit 1; }

LABEL=com.rewalk.voiced
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.config/rewalk/daemon.log"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.config/rewalk"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/bin/daemon.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed LaunchAgent: $PLIST"
echo "log:                   $LOG"
echo
echo "First run only: macOS may show a microphone prompt for rewalk-mic —"
echo "grant it. Check the log for 'daemon up'."

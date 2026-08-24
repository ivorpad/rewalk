#!/bin/sh
# Remove the rewalk voice daemon LaunchAgent.
set -e
LABEL=com.rewalk.voiced
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "removed $PLIST"

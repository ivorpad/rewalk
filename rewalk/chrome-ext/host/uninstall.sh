#!/bin/sh
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.rewalk.host.json"
rm -f "$(cd "$(dirname "$0")" && pwd)/rewalk-host.wrapper.sh"
echo "removed host manifest + wrapper; remove the unpacked extension in chrome://extensions"

#!/bin/sh
# Build and sign rewalk-mic.app and rewalk-voiced.app on THIS machine.
#
# Never ship prebuilt signed binaries: macOS TCC binds the microphone grant to
# the signing identity. A foreign signature is a different app to TCC than one
# signed here. make-signing-identity.sh creates a per-machine identity (run
# once); this script compiles both apps and signs them with it.
#
#   sh lib/mac/build-apps.sh
#   REWALK_SIGN=adhoc sh lib/mac/build-apps.sh   # last resort; grant dies on rebuild
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-apps.sh: macOS only (rewalk-mic / rewalk-voiced are TCC bundles)"
  exit 1
fi
command -v swiftc >/dev/null || { echo "swiftc not found; install Xcode or Command Line Tools"; exit 1; }

IDENTITY="rewalk signing"
if [ "${REWALK_SIGN:-}" = "adhoc" ]; then
  IDENTITY="-"
elif ! security find-identity -v -p codesigning | grep -q "rewalk signing"; then
  echo "no \"$IDENTITY\" identity — creating one (one-time keychain trust dialog)"
  sh "$HERE/make-signing-identity.sh"
fi
if [ "$IDENTITY" != "-" ] && ! security find-identity -v -p codesigning | grep -q "rewalk signing"; then
  echo "WARNING: still no 'rewalk signing' identity — ad-hoc signing; the mic grant will die on the next rebuild"
  IDENTITY="-"
fi

# --- rewalk-mic.app ----------------------------------------------------------
MIC_APP="$HERE/rewalk-mic.app"
MIC_BIN="$MIC_APP/Contents/MacOS/rewalk-mic"
MIC_SRC="$HERE/rewalk-mic-src/rewalk-mic.swift"
mkdir -p "$MIC_APP/Contents/MacOS"
cp "$HERE/rewalk-mic-src/Info.plist" "$MIC_APP/Contents/Info.plist"
if [ ! -x "$MIC_BIN" ] || [ "$MIC_SRC" -nt "$MIC_BIN" ] || [ "${REWALK_FORCE_BUILD:-}" = "1" ]; then
  echo "building rewalk-mic.app..."
  swiftc -O -o "$MIC_BIN" "$MIC_SRC"
fi
codesign --force --sign "$IDENTITY" "$MIC_APP"
echo "signed rewalk-mic.app ($IDENTITY)  id=com.rewalk.mic"

# --- rewalk-voiced.app -------------------------------------------------------
VOICED_APP="$HERE/rewalk-voiced.app"
VOICED_BIN="$VOICED_APP/Contents/MacOS/rewalk-voiced"
VOICED_SRC="$HERE/rewalk-voiced-src/rewalk-voiced.swift"
mkdir -p "$VOICED_APP/Contents/MacOS"
# Info.plist is tracked in the bundle (LSUIElement + NSMicrophoneUsageDescription).
if [ ! -x "$VOICED_BIN" ] || [ "$VOICED_SRC" -nt "$VOICED_BIN" ] || [ "${REWALK_FORCE_BUILD:-}" = "1" ]; then
  echo "building rewalk-voiced.app..."
  swiftc -O -o "$VOICED_BIN" "$VOICED_SRC"
fi
codesign --force --sign "$IDENTITY" "$VOICED_APP"
echo "signed rewalk-voiced.app ($IDENTITY)  id=com.rewalk.voiced"

echo
echo "First use of each app, macOS will prompt for the microphone:"
echo "  com.rewalk.mic     — the capturer (rewalk-mic.app)"
echo "  com.rewalk.voiced  — the menu bar / login daemon wrapper"
echo "Grant both. A denial looks like peak 0.000000, not a crash."

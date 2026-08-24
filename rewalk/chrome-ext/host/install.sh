#!/bin/sh
# Install the native messaging host so Chrome will spawn it for the extension.
# This is the step to run knowingly: it lets the rewalk extension start a
# microphone-recording process on this machine. Read it before running.
#
# The subtlety it handles: Chrome spawns native hosts with a minimal PATH, so a
# wrapper that says `command -v node` fails when a version manager put node
# somewhere non-standard. We resolve node's absolute path now and bake it in.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
[ -x "$NODE" ] || { echo "node not found on PATH; install node first"; exit 1; }

WRAP="$HERE/rewalk-host.wrapper.sh"
cat > "$WRAP" <<WRAP_EOF
#!/bin/sh
exec "$NODE" "$HERE/rewalk-host.mjs"
WRAP_EOF
chmod +x "$WRAP" "$HERE/rewalk-host.mjs"

DEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$DEST"
sed "s#HOST_WRAPPER_PATH#$WRAP#" "$HERE/com.rewalk.host.json" > "$DEST/com.rewalk.host.json"

echo "installed host manifest: $DEST/com.rewalk.host.json"
echo "wrapper (node baked in):  $WRAP  ->  $NODE"
echo "extension id:             $(cat "$HERE/.ext_id")"
echo
echo "Now load the unpacked extension:"
echo "  chrome://extensions  ->  Developer mode ON  ->  Load unpacked  ->  select"
echo "  $HERE/.."

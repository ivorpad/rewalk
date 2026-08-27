#!/bin/sh
# install.sh — make `rewalk` usable on this machine from a git checkout.
#
# JS has no build. The two things that cannot ship as binaries (rewalk-mic.app
# and rewalk-voiced.app) are compiled and signed HERE, with a per-machine
# identity, because macOS TCC binds the microphone grant to that identity.
# Chrome "Load unpacked" and the native-host / daemon scripts stay human:
# this script prints those commands and never runs them.
#
#   git clone https://github.com/ivorpad/rewalk.git && cd rewalk && sh install.sh
#
# Dry-run against a temp prefix (does not touch ~/.local/bin, ~/.claude, or
# ~/.config/rewalk except the key prompt is skipped unless you pass a key):
#
#   sh install.sh --prefix /tmp/rewalk-dry --skip-deepgram
set -e
REPO="$(cd "$(dirname "$0")" && pwd)"
PRODUCT="$REPO/rewalk"
SKILL_SRC="$REPO/rewalk-skill"
PREFIX=""
SKIP_DEEPGRAM=0
SKIP_APPS=0
NONINTERACTIVE=0

usage() {
  cat <<'EOF'
install.sh — install rewalk from this checkout

  sh install.sh [options]

  --prefix DIR       put the CLI shim, skill symlink, and a copy of config
                     under DIR (DIR/bin, DIR/skills, DIR/config/rewalk).
                     Default: ~/.local/bin, ~/.claude/skills, ~/.config/rewalk
  --skip-deepgram    do not prompt for a Deepgram key
  --skip-apps        do not build/sign the macOS bundles (JS + skill only)
  --yes              non-interactive (same as skip-deepgram for the key prompt)
  -h, --help         this text

Human steps this script will NOT run (it prints them at the end):
  chrome-ext/host/install.sh
  Chrome → Load unpacked → chrome-ext/
  daemon/install.sh
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift ;;
    --skip-deepgram) SKIP_DEEPGRAM=1; shift ;;
    --skip-apps) SKIP_APPS=1; shift ;;
    --yes|-y) NONINTERACTIVE=1; SKIP_DEEPGRAM=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -n "$PREFIX" ]; then
  PREFIX="$(mkdir -p "$PREFIX" && cd "$PREFIX" && pwd)"
  BIN_DIR="$PREFIX/bin"
  SKILL_DIR="$PREFIX/skills"
  CONFIG_DIR="$PREFIX/config/rewalk"
else
  BIN_DIR="${REWALK_BIN_DIR:-$HOME/.local/bin}"
  SKILL_DIR="${REWALK_SKILL_DIR:-$HOME/.claude/skills}"
  CONFIG_DIR="${REWALK_CONFIG_DIR:-$HOME/.config/rewalk}"
fi

NODE="$(command -v node || true)"
[ -x "$NODE" ] || { echo "node not found on PATH; install Node >= 18 first"; exit 1; }
NODE_MAJOR="$("$NODE" -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "node $NODE_MAJOR is too old; rewalk needs >= 18"
  exit 1
fi

echo "rewalk install"
echo "  checkout:  $REPO"
echo "  node:      $NODE ($("$NODE" -v))"
echo "  bin:       $BIN_DIR/rewalk"
echo "  skill:     $SKILL_DIR/rewalk"
echo "  config:    $CONFIG_DIR"
echo

# --- JS (zero build) ---------------------------------------------------------
echo "npm install (product + skill/ web-qa engine)..."
( cd "$PRODUCT" && npm install )
# boot.main.js is generated and gitignored; a clone has no extension without this.
echo "building chrome-ext/src/boot.main.js from lib/..."
( cd "$PRODUCT/chrome-ext" && "$NODE" build.mjs )

# --- macOS bundles: compile + sign on THIS machine ---------------------------
# A missing compiler must not cost the whole install: the shim, skill, and
# config below all work without voice. Fail soft with the exact next step;
# `rewalk doctor` verifies the retry.
APPS_OK=0
if [ "$SKIP_APPS" = 1 ]; then
  echo "skipping macOS app build (--skip-apps)"
elif [ "$(uname -s)" != "Darwin" ]; then
  echo "not Darwin — skipping rewalk-mic / rewalk-voiced (voice capture is macOS-only)"
elif ! xcode-select -p >/dev/null 2>&1; then
  echo
  echo "WARNING: Xcode Command Line Tools not found — voice apps skipped."
  echo "  xcode-select --install        # then re-run: sh install.sh"
  echo "  (the JS install continues; sessions are DOM-only until then)"
  echo
elif sh "$PRODUCT/lib/mac/build-apps.sh"; then
  APPS_OK=1
else
  echo
  echo "WARNING: voice app build failed — continuing without voice."
  echo "  Fix the error above, re-run: sh install.sh    Verify: rewalk doctor"
  echo
fi

# --- CLI shim: bake node + this checkout, same reason as the native host -----
mkdir -p "$BIN_DIR"
SHIM="$BIN_DIR/rewalk"
cat > "$SHIM" <<SHIM_EOF
#!/bin/sh
exec "$NODE" "$PRODUCT/bin/rewalk.mjs" "\$@"
SHIM_EOF
chmod +x "$SHIM"
echo "wrote $SHIM"

# The hook shim is separate from the CLI shim on purpose: PostToolUse fires on
# every tool call of every agent session, and bin/hook.mjs is four builtins deep
# where bin/rewalk.mjs spawns a second node. Same reason tap ships tap-hook.
HOOK_SHIM="$BIN_DIR/rewalk-hook"
cat > "$HOOK_SHIM" <<HOOK_EOF
#!/bin/sh
exec "$NODE" "$PRODUCT/bin/hook.mjs" "\$@"
HOOK_EOF
chmod +x "$HOOK_SHIM"
echo "wrote $HOOK_SHIM"

# --- Claude Code skill -------------------------------------------------------
if [ -d "$SKILL_SRC" ]; then
  mkdir -p "$SKILL_DIR"
  ln -sfn "$SKILL_SRC" "$SKILL_DIR/rewalk"
  echo "skill -> $SKILL_DIR/rewalk  (symlink to $SKILL_SRC)"
else
  echo "WARNING: $SKILL_SRC missing — skill not linked"
fi

# --- config.json (do not overwrite a user's file) ----------------------------
mkdir -p "$CONFIG_DIR"
"$NODE" "$PRODUCT/bin/ensure-config.mjs" "$CONFIG_DIR/config.json"

# --- Deepgram: prompt-or-skip; key never in env ------------------------------
KEY_FILE="$CONFIG_DIR/deepgram.key"
if [ -s "$KEY_FILE" ]; then
  echo "Deepgram key already at $KEY_FILE (left untouched)"
elif [ "$SKIP_DEEPGRAM" = 1 ] || [ "$NONINTERACTIVE" = 1 ]; then
  echo "no Deepgram key — sessions will be DOM-only until you write one to"
  echo "  $KEY_FILE   (0600). Live voice-to-text needs it; replay still works."
elif [ -t 0 ]; then
  echo
  echo "Deepgram key (optional). Live voice-to-text uses this file at the moment"
  echo "of use; it is never put in the environment. Enter to skip (DOM-only)."
  printf "key: "
  # stty -echo so the key does not linger in the terminal scrollback
  if stty -echo 2>/dev/null; then
    trap 'stty echo' EXIT
    IFS= read -r DGKEY || true
    stty echo
    trap - EXIT
    echo
  else
    IFS= read -r DGKEY || true
  fi
  if [ -n "$DGKEY" ]; then
    umask 077
    printf '%s\n' "$DGKEY" > "$KEY_FILE"
    chmod 0600 "$KEY_FILE"
    echo "wrote $KEY_FILE (0600)"
  else
    echo "skipped — DOM-only until $KEY_FILE exists"
  fi
else
  echo "stdin is not a TTY; skipping Deepgram prompt. Write a key to $KEY_FILE (0600) later."
fi

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "NOTE: $BIN_DIR is not on PATH. Add it, e.g."
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

# --- human-consent steps: print, never run -----------------------------------
EXT="$PRODUCT/chrome-ext"
cat <<EOF

================================================================
Human steps — this installer does not run these.

1. Chrome extension (Load unpacked). chrome://extensions → Developer mode ON
   → Load unpacked → select:

     $EXT

   The pinned key keeps the extension id stable (the native-host manifest
   depends on it).

2. Native messaging host (lets the extension start a recording process).
   Read it, then run it knowingly:

     sh $EXT/host/install.sh

3. Agent hooks (lets a comment from the browser reach a Claude Code or Codex
   session). This edits ~/.claude/settings.json — and ~/.codex/hooks.json when
   Codex is set up — adding four entries that run:

     $HOOK_SHIM

   It backs the file up first and removes only its own entries. Run it
   knowingly:

     $NODE $PRODUCT/bin/install-hooks.mjs

4. Optional: login voice daemon + menu bar (toolbar button is then the
   whole interface). Read daemon/README.md, then:

     sh $PRODUCT/daemon/install.sh

Microphone prompts (one-time, per signing identity on this machine):
  com.rewalk.mic     — first capture through rewalk-mic.app
  com.rewalk.voiced  — first launch of the menu bar / LaunchAgent wrapper
Grant both. A denial is peak 0.000000, not an error dialog.

Then:
  $BIN_DIR/rewalk doctor         # every install step verified, failures name their fix
  $BIN_DIR/rewalk mic 6          # talk; READY means go
  $BIN_DIR/rewalk session        # click the toolbar button to start/stop

Updating (after every git pull):
  sh install.sh                  # deps, boot.main.js, re-sign (the mic grant survives)
  chrome://extensions → reload   # Chrome runs the OLD extension until you do this
  $BIN_DIR/rewalk doctor
================================================================
EOF
if [ "$APPS_OK" != 1 ] && [ "$SKIP_APPS" != 1 ] && [ "$(uname -s)" = "Darwin" ]; then
  echo "NOTE: voice apps were NOT built this run — the microphone prompts above"
  echo "      will not appear until a re-run of install.sh succeeds."
fi

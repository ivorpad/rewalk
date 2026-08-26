#!/bin/sh
# bootstrap.sh — the one-liner entry: clone rewalk to a permanent home, then
# run the real installer FROM DISK.
#
#   curl -fsSL https://raw.githubusercontent.com/ivorpad/rewalk/main/bootstrap.sh | sh
#   curl -fsSL .../bootstrap.sh | sh -s -- --skip-deepgram   # args go to install.sh
#   REWALK_HOME=~/src/rewalk  curl -fsSL .../bootstrap.sh | sh
#
# This file only chooses where the checkout lives. Everything consequential —
# compiling, signing, the shim, the printed consent steps — happens in
# install.sh, which sits in the checkout where a person can read it. The
# checkout IS the installation (the shim and the native-host wrapper bake its
# absolute path), so the default home is ~/.rewalk, not a temp dir. Re-running
# updates: an existing checkout gets `git pull --ff-only`, which refuses
# rather than clobbering local edits.
#
# The whole script runs through main() called on the last line, so a
# truncated download executes nothing.
set -e

main() {
  REPO_URL="https://github.com/ivorpad/rewalk.git"
  HOME_DIR="${REWALK_HOME:-$HOME/.rewalk}"

  command -v git >/dev/null 2>&1 || { echo "git not found — install it first (macOS: xcode-select --install)"; exit 1; }
  command -v node >/dev/null 2>&1 || { echo "node not found — rewalk needs Node >= 18 (https://nodejs.org)"; exit 1; }

  if [ -d "$HOME_DIR/.git" ]; then
    echo "rewalk already at $HOME_DIR — updating"
    git -C "$HOME_DIR" pull --ff-only
  else
    echo "cloning rewalk -> $HOME_DIR"
    git clone "$REPO_URL" "$HOME_DIR"
  fi

  echo
  sh "$HOME_DIR/install.sh" "$@"
}

main "$@"

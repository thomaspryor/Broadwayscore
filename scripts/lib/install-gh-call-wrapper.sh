#!/bin/bash
# Installs (or removes) the gh-call-wrapper.sh instrumentation in front of the
# real `gh` binary. See gh-call-wrapper.sh for the incident this fixes
# (task #821). Idempotent — safe to re-run.
#
# Usage:
#   scripts/lib/install-gh-call-wrapper.sh            install
#   scripts/lib/install-gh-call-wrapper.sh --uninstall remove, restore real gh
#   scripts/lib/install-gh-call-wrapper.sh --status    report current state
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-gh-call-wrapper.sh [--uninstall|--status|--help]
  (no args)    install the wrapper in front of the real gh binary
  --uninstall  remove the wrapper, restore the real gh binary
  --status     report whether the wrapper is currently installed
  --help/-h    show this usage text (does NOT install/uninstall anything)
EOF
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
esac

GH_BIN="$(command -v gh || true)"
if [ -z "$GH_BIN" ]; then
  echo "gh not found on PATH — nothing to do." >&2
  exit 1
fi
GH_DIR="$(dirname "$GH_BIN")"
GH_REAL="$GH_DIR/gh.real"
WRAPPER_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-call-wrapper.sh"

status() {
  if [ -e "$GH_REAL" ]; then
    echo "INSTALLED — $GH_BIN is the wrapper, real binary at $GH_REAL"
  else
    echo "NOT INSTALLED — $GH_BIN is the unmodified real binary"
  fi
}

uninstall() {
  if [ ! -e "$GH_REAL" ]; then
    echo "Not installed (no $GH_REAL) — nothing to uninstall."
    exit 0
  fi
  mv -f "$GH_REAL" "$GH_BIN"
  echo "Restored real gh binary at $GH_BIN."
}

install() {
  if [ -e "$GH_REAL" ]; then
    echo "Already installed ($GH_REAL exists) — reinstalling wrapper copy only."
    cp "$WRAPPER_SRC" "$GH_BIN"
    chmod +x "$GH_BIN"
    exit 0
  fi
  if [ ! -f "$WRAPPER_SRC" ]; then
    echo "Wrapper source not found at $WRAPPER_SRC" >&2
    exit 1
  fi
  before_version="$("$GH_BIN" --version 2>&1 | head -1)"
  mv "$GH_BIN" "$GH_REAL"
  cp "$WRAPPER_SRC" "$GH_BIN"
  chmod +x "$GH_BIN"
  after_version="$("$GH_BIN" --version 2>&1 | head -1)"
  if [ "$before_version" != "$after_version" ]; then
    echo "VERSION MISMATCH after install — rolling back." >&2
    mv -f "$GH_REAL" "$GH_BIN"
    exit 1
  fi
  echo "Installed. $GH_BIN now logs to ~/.claude/gh-call-ledger.log before delegating to $GH_REAL."
  echo "Verified: gh --version unchanged ($after_version)."
  echo "Rollback: $0 --uninstall"
}

case "${1:-}" in
  --uninstall) uninstall ;;
  --status) status ;;
  *) install ;;
esac

#!/bin/bash
# Cloud data bootstrap — make the app buildable in a stateless cloud sandbox.
#
# src/lib/data-core.ts hard-imports data/shows.json (+ ~30 other data/*.json).
# Locally those are symlinks into the private core-data repo. In a cloud
# session (iOS / Mac app / claude.ai/code) there is no symlink and no clone,
# so the app cannot even build. This script produces a usable dataset by the
# best available means:
#
#   1. Data already present   -> no-op (local CLI, or a warm cloud container)
#   2. REVIEW_TEXTS_TOKEN / gh -> clone the real private repos (setup-local-data.sh)
#   3. Neither                 -> synthesize a buildable STUB from the committed
#                                 public/data/mobile-shows.json (cloud-stub-data.js)
#
# It also installs @notionhq/client on demand so notion-brain.js works when
# NOTION_API_KEY is set (the module is not in the committed node_modules).
#
# Safe to run repeatedly and from any environment: it never overwrites tracked
# files (the stub generator guards on `git ls-files`) and fast-exits when data
# is already there. Always exits 0 so it can be wired into a SessionStart hook
# without ever blocking a session.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT" || exit 0

log() { echo "[cloud-bootstrap] $*"; }

# Run a command with a wall-clock cap when `timeout` exists (it does on the cloud
# Ubuntu image; may be absent on local macOS, where this path doesn't run anyway
# because data is already present). Prevents a hung npm/clone from stalling the
# SessionStart hook indefinitely.
run_bounded() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    "$@"
  fi
}

ensure_notion_client() {
  # notion-brain.js needs @notionhq/client, which isn't in committed deps.
  if [ -n "${NOTION_API_KEY:-}" ] && ! node -e "require('@notionhq/client')" >/dev/null 2>&1; then
    log "NOTION_API_KEY set but @notionhq/client missing -> npm install --no-save"
    run_bounded 120 npm install --no-save @notionhq/client >/dev/null 2>&1 \
      && log "installed @notionhq/client" \
      || log "WARN: could not install @notionhq/client in time (notion-brain.js will fail)"
  fi
}

# 1. Real data already resolvable (symlink or file with content)? Nothing to do.
if [ -s data/shows.json ]; then
  ensure_notion_client
  exit 0
fi

log "data/shows.json missing — bootstrapping cloud dataset"

# 2. Try the real private repos if we have any way to authenticate. In a cloud
# session (CLAUDE_CODE_REMOTE=true) we try even without a token or gh, because
# setup-local-data.sh has a tokenless proxy-clone path that only works there.
# Bounded so a stuck clone can't hang SessionStart. NOTE: if an existing
# $HOME/broadway-scorecard-data clone is present, setup-local-data.sh git-reset
# --hard's it — safe in ephemeral cloud, but don't point this at a repo with
# uncommitted work.
if [ -n "${REVIEW_TEXTS_TOKEN:-}" ] || command -v gh >/dev/null 2>&1 || [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  log "attempting real data via setup-local-data.sh"
  run_bounded 300 bash "$SCRIPT_DIR/setup-local-data.sh" 2>&1 | sed 's/^/[setup-local-data] /' || true
fi

# 3. Still nothing? Fall back to a synthesized stub so the app can build.
if [ ! -s data/shows.json ]; then
  log "no private-repo access — synthesizing STUB dataset from public/data/mobile-shows.json"
  log "NOTE: reviews/scores are empty in stub mode; use this only for UI/build work"
  node "$SCRIPT_DIR/cloud-stub-data.js" 2>&1 | sed 's/^/[cloud-stub] /' || true
fi

if [ -s data/shows.json ]; then
  log "dataset ready ($(node -e "try{console.log(require('./data/shows.json').shows.length+' shows')}catch(e){console.log('present')}" 2>/dev/null))"
else
  log "WARN: still no data/shows.json — app build will fail; set REVIEW_TEXTS_TOKEN"
fi

ensure_notion_client
exit 0

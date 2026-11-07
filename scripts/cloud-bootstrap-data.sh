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
# Safe to run repeatedly and from any environment: it never overwrites tracked
# files (the stub generator guards on `git ls-files`) and fast-exits when data
# is already there. Always exits 0 so it can be wired into a SessionStart hook
# without ever blocking a session.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/core-data-clone-guard.sh
source "$SCRIPT_DIR/lib/core-data-clone-guard.sh"
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

# Loud, so a session that needs review texts (audits, recovery) finds out at start
# rather than halfway through. Cloud only: local checkouts manage their own data.
warn_if_no_review_texts() {
  # setup-local-data.sh --all creates data/review-texts before cloning, so a failed
  # clone leaves an EMPTY directory: test for missing or empty, not just missing.
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ -s data/shows.json ] \
     && [ -z "$(ls -A data/review-texts 2>/dev/null)" ]; then
    log "WARN: data/review-texts is missing, so review texts are NOT available this session."
    if [ -n "${REVIEW_TEXTS_TOKEN:-}" ]; then
      log "WARN: REVIEW_TEXTS_TOKEN is set but the broadway-review-texts clone failed; check the token has repo scope."
    else
      log "WARN: attach broadway-review-texts to the session (or set REVIEW_TEXTS_TOKEN), then start a new session."
    fi
  fi
}

# 0. Fresh data in a warm container (BRO-5008). The cloud environment is a
# snapshot: $HOME/broadway-scorecard-data was cloned when the snapshot was taken
# and the step-1 fast exit below never refreshed it, so sessions read core data
# days old (2026-10-10 read the 10-06 snapshot). The git proxy authenticates the
# repos attached to the session, so a fetch works whenever the owner attached
# broadway-scorecard-data. Only our own clean clone on main is ever reset.
CORE_HOME="$HOME/broadway-scorecard-data"
refresh_core_data() {
  [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || return 0
  [ -d "$CORE_HOME/.git" ] && [ ! -L "$CORE_HOME" ] || return 0
  local why
  if why="$(core_clone_local_work "$CORE_HOME")"; then
    log "not refreshing the core data clone: $why"
  elif run_bounded 90 git -C "$CORE_HOME" fetch -q --depth 1 origin main 2>/dev/null \
       && git -C "$CORE_HOME" reset -q --hard FETCH_HEAD 2>/dev/null; then
    :
  else
    log "WARN: could not refresh core data (broadway-scorecard-data not attached to this session?)"
  fi
  log "core data as of $(git -C "$CORE_HOME" log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M UTC' 2>/dev/null)"
}
# A session-attached broadway-review-texts clone (/home/user/<repo>, next to this
# checkout) gives review texts with no REVIEW_TEXTS_TOKEN: setup-local-data.sh
# copies its origin/main into data/ the same way the Mac layout has it.
# BSC_ATTACHED_REPOS_DIR (default /home/user): where attached repos live. Tests
# point it at their fixture, or every run copied the real ~1.7 GB clone into
# /tmp and leaked it when the test timed out (BRO-5422/5443, BRO-5384).
attached_review_texts() {
  local d
  for d in "$(dirname "$ROOT")" "${BSC_ATTACHED_REPOS_DIR:-/home/user}"; do
    [ -d "$d/broadway-review-texts/.git" ] && { echo "$d/broadway-review-texts"; return 0; }
  done
  return 1
}
# BRO-5217: cloud data/*.json are plain copies of the clone (setup-local-data.sh
# CLOUD_COPY), so reading them never leaves the working directory and never
# stops on a permission prompt. Re-copy when a link into the clone is still
# there (a snapshot from before BRO-5217), or at startup/resume when the clone
# moved past the commit last copied (data/.core-data-sha; also replaces a stub
# or a copy baked into a snapshot). compact/clear keep the session's copies.
cloud_core_copies() {
  [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || return 0
  [ -d "$CORE_HOME/.git" ] || return 0
  if [ "${BSC_CLOUD_DATA_SYMLINK:-}" = "1" ]; then
    # Kill switch: undo an earlier conversion (setup-local-data.sh relinks when the marker is there).
    [ -f data/.core-data-sha ] || return 0
    run_bounded 120 bash "$SCRIPT_DIR/setup-local-data.sh" --link-only 2>&1 \
      | grep -E 'Linked|WARN|ERROR' | sed 's/^/[setup-local-data] /' || true
    return 0
  fi
  local head have linked
  head="$(git -C "$CORE_HOME" rev-parse HEAD 2>/dev/null)"
  have="$(cat data/.core-data-sha 2>/dev/null)"
  linked="$(find data -maxdepth 1 -name '*.json' -lname "$CORE_HOME/*" 2>/dev/null | head -1)"
  case "${BSC_SESSION_EVENT:-startup}" in
    compact|clear) [ -n "$linked" ] || return 0 ;;
    *) [ -n "$linked" ] || [ "$head" != "$have" ] || return 0 ;;
  esac
  run_bounded 120 bash "$SCRIPT_DIR/setup-local-data.sh" --link-only 2>&1 \
    | grep -E 'Core data:|WARN|ERROR' | sed 's/^/[setup-local-data] /' || true
}
refresh_core_data
cloud_core_copies
# BRO-5400: copy when data/review-texts is empty, AND re-copy at startup/resume when
# its .review-texts-sha stamp is behind the clone (a copy baked into an earlier
# session or snapshot was never replaced). Decision: scripts/lib/review-texts-refresh.js.
# setup-local-data.sh builds the fresh copy beside the old one and swaps, so a failed
# or timed-out copy leaves the old tree in place; the check below then says STALE.
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && RT_SRC="$(attached_review_texts)"; then
  RT_DECISION="copy data/review-texts is missing or empty"
  if [ -n "$(ls -A data/review-texts 2>/dev/null)" ]; then
    RT_DECISION="$(node "$SCRIPT_DIR/lib/review-texts-refresh.js" decide data/review-texts "$RT_SRC" "${BSC_SESSION_EVENT:-startup}" 2>/dev/null)" \
      || RT_DECISION="keep refresh check failed"
  fi
  case "$RT_DECISION" in
    copy*)
      # A copy killed by the timeout below leaves its half-built tree (hundreds of MB)
      # under a PID-named path that no later run would remove.
      rm -rf data/.review-texts.new.* data/.review-texts.old.* 2>/dev/null || true
      log "copying review texts from the session-attached clone $RT_SRC (about a minute; ${RT_DECISION#copy })"
      REVIEW_TEXTS_SOURCE="$RT_SRC" run_bounded 300 bash "$SCRIPT_DIR/setup-local-data.sh" --all 2>&1 \
        | grep -E 'ERROR|FATAL|Review texts|files copied|Setup complete' | sed 's/^/[setup-local-data] /' || true
      ;;
  esac
  node "$SCRIPT_DIR/lib/review-texts-refresh.js" check data/review-texts "$RT_SRC" 2>/dev/null | sed 's/^/[cloud-bootstrap] /' || true
fi

# 1. Real data already resolvable (symlink or file with content)? Nothing to do.
if [ -s data/shows.json ]; then
  warn_if_no_review_texts
  exit 0
fi

log "data/shows.json missing — bootstrapping cloud dataset"

# 2. Try the real private repos if we have any way to authenticate. In a cloud
# session (CLAUDE_CODE_REMOTE=true) we try even without a token or gh, because
# setup-local-data.sh has a tokenless proxy-clone path that only works there.
# Bounded so a stuck clone can't hang SessionStart. An existing
# $HOME/broadway-scorecard-data clone is only reset when it has no local work
# (scripts/lib/core-data-clone-guard.sh, BRO-3337).
if [ -n "${REVIEW_TEXTS_TOKEN:-}" ] || command -v gh >/dev/null 2>&1 || [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  # Review texts (~234 MB, broadway-review-texts) clone only with --all. Opt in via
  # REVIEW_TEXTS_TOKEN so routines and UI-only sessions without it stay fast.
  if [ -n "${REVIEW_TEXTS_TOKEN:-}" ]; then
    log "attempting real data + review texts via setup-local-data.sh --all"
    run_bounded 300 bash "$SCRIPT_DIR/setup-local-data.sh" --all 2>&1 | sed 's/^/[setup-local-data] /' || true
  else
    log "attempting real data via setup-local-data.sh"
    run_bounded 300 bash "$SCRIPT_DIR/setup-local-data.sh" 2>&1 | sed 's/^/[setup-local-data] /' || true
  fi
fi

warn_if_no_review_texts

# 3. Run the stub generator UNCONDITIONALLY as a gap-fill. cloud-stub-data.js
# skips any path that already exists (symlinks from a real clone included) and
# never touches git-tracked files, so:
#   - no real data  -> it writes the full stub set (app builds, empty scores)
#   - real data      -> it writes ONLY the gitignored, locally-generated files the
#                       private repo doesn't ship (cast-manifest.json, actor-slugs.json,
#                       video-reviews.json, ...). Without this, `tsc`/build fails with
#                       TS2307 on those static imports even when real data is present.
if [ ! -s data/shows.json ]; then
  log "no private-repo access — synthesizing full STUB dataset from public/data/mobile-shows.json"
  log "NOTE: reviews/scores are empty in stub mode; use this only for UI/build work"
else
  log "real data present — filling gitignored generated-file gaps so the app builds"
fi
node "$SCRIPT_DIR/cloud-stub-data.js" 2>&1 | sed 's/^/[cloud-stub] /' || true

if [ -s data/shows.json ]; then
  log "dataset ready ($(node -e "try{console.log(require('./data/shows.json').shows.length+' shows')}catch(e){console.log('present')}" 2>/dev/null))"
else
  log "WARN: still no data/shows.json — app build will fail; set REVIEW_TEXTS_TOKEN"
fi

exit 0

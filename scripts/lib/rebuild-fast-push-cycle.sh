#!/usr/bin/env bash
# rebuild-fast-push-cycle.sh — bounded outer push loop for rebuild-fast.yml (BRO-2783).
#
# Usage (HEAD must already carry the commit to push):
#   REBUILD_FAST_REDO_CMD='bash scripts/rebuild-fast-redo.sh' \
#     bash scripts/lib/rebuild-fast-push-cycle.sh
#
# Each cycle runs PUSH_CMD (default: push-with-retry.sh 20 main). If that loses
# its whole retry budget to a hot main, instead of exiting failure and
# stranding a fully scored rebuild, it:
#   1. waits a jittered delay,
#   2. fetches origin/<branch> and `git reset --hard`s onto it (dropping the
#      lost commit; the redo regenerates it from the same local inputs),
#   3. runs REBUILD_FAST_REDO_CMD, which redoes the fast rebuild on the fresh
#      tree and commits (exit 0), or finds nothing left to commit (exit 3),
#   4. pushes again.
# Bounded: REBUILD_FAST_MAX_CYCLES total cycles (default 2, hard cap 5, see
# rebuild-fast-push-cycle.js). Every decision comes from that JS helper.
#
# Env:
#   PUSH_CMD                         push command (eval'd). Default above.
#   REBUILD_FAST_REDO_CMD            required redo command (eval'd). Receives
#                                    REBUILD_FAST_LOST_COMMIT (the commit that
#                                    failed to land) and REBUILD_FAST_CYCLE.
#   REBUILD_FAST_MAX_CYCLES          total cycles incl. the first push.
#   REBUILD_FAST_REDO_PUSH_DEADLINE_SEC  PUSH_DEADLINE_SEC for redo cycles
#                                    (default 300: a fresh-HEAD push should land
#                                    fast; keeps the job inside timeout-minutes).
#   REBUILD_FAST_JITTER_MAX_SEC      cap on the pre-redo sleep (default 20).
#   PUSH_BRANCH                      remote branch (default main).
#   GIT_NET_TIMEOUT_SEC              per-fetch timeout (default 90).
#
# Exit: 0 pushed (or nothing left to push), the push's own exit code when it
# fails for good (4 = hook rejected passes through), 1 on a redo failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/rebuild-fast-push-cycle.js"

PUSH_BRANCH="${PUSH_BRANCH:-main}"
PUSH_CMD="${PUSH_CMD:-bash \"$SCRIPT_DIR/push-with-retry.sh\" 20 $PUSH_BRANCH}"
: "${REBUILD_FAST_REDO_CMD:?REBUILD_FAST_REDO_CMD is required}"
MAX_CYCLES="$(node "$HELPER" max-cycles "${REBUILD_FAST_MAX_CYCLES:-}")"
REDO_DEADLINE="${REBUILD_FAST_REDO_PUSH_DEADLINE_SEC:-300}"
JITTER_MAX="${REBUILD_FAST_JITTER_MAX_SEC:-20}"
NET_TIMEOUT="${GIT_NET_TIMEOUT_SEC:-90}"

_TIMEOUT_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
_timeout() {
  local secs="$1"; shift
  if [ -n "$_TIMEOUT_BIN" ]; then "$_TIMEOUT_BIN" -k 10 "$secs" "$@"; else "$@"; fi
}

cycle=1
while :; do
  # The commit THIS run is trying to land, recorded BEFORE PUSH_CMD runs. After
  # a failed push-with-retry.sh, HEAD may no longer be it: its merge fallback
  # (`merge -X ours`) can leave a merge commit M as HEAD, and
  # restore_head_if_moved keeps a descendant HEAD. M^..M is then the OTHER
  # writers' diff, so the redo must be handed entry_head, never post-push HEAD.
  entry_head="$(git rev-parse HEAD)"
  echo "[rebuild-fast-push-cycle] cycle $cycle/$MAX_CYCLES: pushing $(git rev-parse --short "$entry_head")"
  set +e
  if [ "$cycle" -gt 1 ]; then
    ( export PUSH_DEADLINE_SEC="$REDO_DEADLINE"; eval "$PUSH_CMD" )
  else
    ( eval "$PUSH_CMD" )
  fi
  push_rc=$?
  set -e

  action="$(node "$HELPER" decide --exit="$push_rc" --cycle="$cycle" --max="$MAX_CYCLES")"
  case "$action" in
    done) echo "[rebuild-fast-push-cycle] landed on cycle $cycle"; exit 0 ;;
    redo) ;;
    *)
      echo "::error::rebuild-fast push failed for good after $cycle/$MAX_CYCLES cycle(s) (last push exit $push_rc)"
      [ "$push_rc" -ne 0 ] && exit "$push_rc"
      exit 1 ;;
  esac

  lost_commit="$entry_head"
  if [ "$(git rev-parse HEAD)" != "$entry_head" ]; then
    echo "[rebuild-fast-push-cycle] push left HEAD at $(git rev-parse --short HEAD), not this run's commit; using the pre-push commit $entry_head as the lost commit"
  fi
  delay="$(node "$HELPER" jitter --cycle="$cycle" --max-sec="$JITTER_MAX")"
  echo "::warning::rebuild-fast lost its push race (exit $push_rc) on cycle $cycle/$MAX_CYCLES — redoing the fast rebuild on fresh origin/$PUSH_BRANCH in ${delay}s (lost commit $lost_commit)"
  sleep "$delay"

  # Clear any half-finished rebase/merge push-with-retry.sh may have left,
  # then move onto the fresh remote tip. Shallow-safe (depth 1) fetch.
  git rebase --abort >/dev/null 2>&1 || true
  git merge --abort >/dev/null 2>&1 || true
  if ! _timeout "$NET_TIMEOUT" git fetch --quiet --depth=1 origin "+$PUSH_BRANCH:refs/remotes/origin/$PUSH_BRANCH"; then
    echo "::error::rebuild-fast redo: fetch of origin/$PUSH_BRANCH failed; keeping lost commit $lost_commit as HEAD"
    exit 1
  fi
  git reset --hard --quiet "refs/remotes/origin/$PUSH_BRANCH"

  set +e
  ( export REBUILD_FAST_LOST_COMMIT="$lost_commit" REBUILD_FAST_CYCLE="$cycle"; eval "$REBUILD_FAST_REDO_CMD" )
  redo_rc=$?
  set -e
  after="$(node "$HELPER" after-redo --exit="$redo_rc")"
  case "$after" in
    push) ;;
    done) echo "[rebuild-fast-push-cycle] fresh origin/$PUSH_BRANCH already carries this rebuild; nothing to push"; exit 0 ;;
    *) echo "::error::rebuild-fast redo failed (exit $redo_rc) on cycle $cycle"; exit 1 ;;
  esac
  cycle=$((cycle + 1))
done

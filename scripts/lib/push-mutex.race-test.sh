#!/usr/bin/env bash
# push-mutex.race-test.sh — functional race test for task #556.
#
# The mutex's lock identity is `git rev-parse --git-common-dir`, which is
# shared by the main checkout and every `git worktree` of the SAME repo (but
# NOT across separate `git clone`s, which each get their own .git). So this
# test reproduces the real topology: one clone acting as the main checkout,
# plus a `git worktree add` off it acting as a second concurrent session —
# exactly what EnterWorktree produces in practice. Both then race to push to
# a shared bare "origin" while holding the SAME mutex.
#
# Asserts:
#   1. The two critical sections never overlapped (mutex actually serialized
#      them) — verified via a start/end timestamp log, not just "both ran".
#   2. Both pushes landed on origin (neither was lost).
#
# Not wired into CI (this is a local dev-time verification tool, per the
# card's acceptance criteria) — run manually:
#   bash scripts/lib/push-mutex.race-test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== setting up bare origin + one clone with a worktree in $WORK =="
git init -q --bare "$WORK/origin.git"

git init -q "$WORK/seed"
(
  cd "$WORK/seed"
  git config user.email t@example.com
  git config user.name t
  mkdir -p scripts/lib
  cp "$HERE/push-mutex.sh" scripts/lib/push-mutex.sh
  git add scripts/lib/push-mutex.sh
  git commit -q -m "initial"
  git branch -M main
  git remote add origin "$WORK/origin.git"
  git push -q origin main
)

# --branch main pinned (BRO-2597 cousin): the bare origin's HEAD is never
# set, so without it this clone picks whatever init.defaultBranch the host
# configures, which can leave the checkout empty on hosts where that
# default isn't "main".
git clone -q --branch main "$WORK/origin.git" "$WORK/main-checkout"
(
  cd "$WORK/main-checkout"
  git config user.email t@example.com
  git config user.name t
)
git -C "$WORK/main-checkout" worktree add -q -b session-b "$WORK/worktree-b" origin/main

LOG="$WORK/order.log"
: > "$LOG"

# Each pusher: acquire the mutex, log start, sleep (to make an overlap
# trivially observable if the mutex is NOT working), commit a unique file,
# push, log end, release.
run_pusher() {
  local name="$1" dir="$2" pushref="$3"
  (
    cd "$dir"
    # shellcheck source=/dev/null
    source scripts/lib/push-mutex.sh
    PUSH_LOCK_TIMEOUT_SEC=30 push_mutex_acquire
    echo "START $name $(date +%s.%N) held=$PUSH_MUTEX_HELD" >> "$LOG"
    sleep 0.5
    echo "own file for $name" > "file-$name.txt"
    git add "file-$name.txt"
    git commit -q -m "add file-$name"
    # Push with a tiny retry since both sessions start from the same base and
    # the second to actually push (inside its own critical section) needs to
    # fast-forward past the first's commit.
    ok=0
    for _ in 1 2 3 4 5; do
      if git push -q origin "$pushref" 2>/dev/null; then ok=1; break; fi
      git fetch -q origin main
      git merge -q --no-edit origin/main >/dev/null 2>&1 || true
      sleep 0.2
    done
    echo "END $name $(date +%s.%N) pushed=$ok" >> "$LOG"
    push_mutex_release
  )
}

echo "== launching two pushers concurrently (main checkout + its worktree) =="
run_pusher a "$WORK/main-checkout" "main" &
PID_A=$!
run_pusher b "$WORK/worktree-b" "HEAD:main" &
PID_B=$!
wait "$PID_A" "$PID_B"

echo "== order log =="
cat "$LOG"

# --- Assertion 1: critical sections did not overlap ---
sort -k3,3 -n "$LOG" > "$WORK/sorted.log"
awk '
  { kind=$1; name=$2 }
  bad { next }
  kind == "START" {
    if (holder != "") { print "OVERLAP: " name " started while " holder " still held the lock"; bad=1; next }
    holder = name
  }
  kind == "END" {
    if (holder != name) { print "MISMATCH: " name " ended but holder was " holder; bad=1; next }
    holder = ""
  }
  END {
    if (bad) { exit 1 }
    print "no overlap detected -- mutex serialized both critical sections"
  }
' "$WORK/sorted.log" || fail "critical sections OVERLAPPED — mutex did not serialize"

# --- Assertion 2: neither push was lost ---
git -C "$WORK/main-checkout" fetch -q origin main
FILES_ON_ORIGIN=$(git -C "$WORK/main-checkout" ls-tree -r --name-only origin/main)
for f in file-a.txt file-b.txt; do
  echo "$FILES_ON_ORIGIN" | grep -qx "$f" || fail "$f missing from origin/main -- a push was lost"
done

echo "PASS: mutex serialized both pushers and neither push was lost"

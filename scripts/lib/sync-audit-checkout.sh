#!/usr/bin/env bash
# scripts/lib/sync-audit-checkout.sh — shared "am I fresh?" gate for
# launchd-scheduled jobs that share this checkout with GitHub Actions CI
# commits (task #732).
#
# THE BUG THIS CLOSES: a degraded run (missing secret, timeout, crash mid-
# write) can leave a TRUNCATED data/audit/*.json snapshot behind. That dirty
# file then blocks the next job's `git merge --ff-only origin/main`. If the
# caller swallows that failure with `|| echo "...running with local code"`,
# the job silently proceeds on STALE code — and being stale, is itself more
# likely to write another degraded snapshot, re-dirtying the tree. One bad
# run guarantees the next is bad too; local main drifted 269 commits behind
# origin this way before it was caught.
#
# What this script does instead:
#   1. Fetch + attempt a fast-forward merge to origin/main.
#   2. On failure, reset ONLY dirty data/audit/ files that are NOT *.jsonl.
#      Those .jsonl files are append-only ledgers that can hold both a local
#      AND an origin-side append; discarding the local side loses real data.
#      The full-file JSON snapshots under data/audit/ are safe to discard —
#      the next audit run regenerates them from scratch. Then retry the
#      merge.
#   3. If it still can't fast-forward — real local commits ahead of origin,
#      or dirty files outside the safe reset list — FAIL LOUDLY (exit 1)
#      instead of letting the caller fall through to stale code. Callers
#      that chain with `&&` (the launchd inline pattern) get this for free.
#
# Concurrency: this repo runs many launchd jobs and worktree sessions that
# touch the SAME checkout, and merge-worktree-to-main.sh already established
# the convention of serializing mutating git ops here via push-mutex.sh
# (task #556, incidents #208/#543/#546). The reset+merge sequence below is
# mutating (git checkout on data/audit/ paths), so it acquires the same
# mutex — fail-open on timeout, same as every other caller.
#
# Usage: bash scripts/lib/sync-audit-checkout.sh [repo-dir]
# Exits 0 (already fresh, or recovered) or 1 (blocked — investigate).
#
# VISIBLE ALERT (task #1563 review finding): the refusal branch used to only
# print `::error::` lines to a bare `/tmp/<job>-launchd.log` — every other
# Mac-local launchd job in this repo treats that as equivalent to nobody
# looking (health-check.js:3371, check-claude-auth-health.js:92,
# backlog-drain.js:542, reconcile-dead-completions.js:190 all write a
# monitored data/audit/ snapshot instead of relying on a log tail), so a
# refusal here was just as silent as the bug this script exists to fix. On
# refuse, this writes data/audit/sync-refused-<tag>.json (gitignored,
# Mac-local); send-morning-digest.js renders a block for any snapshot found.
# Cleared on every successful run (clean or recovered) so a stale refusal
# doesn't read as "still blocked" forever after the next tick succeeds.
set -uo pipefail

REPO_DIR="${1:-$(pwd)}"
TAG="${SYNC_TAG:-sync-audit-checkout}"
SNAPSHOT_FILE="data/audit/sync-refused-${TAG}.json"

cd "$REPO_DIR" || { echo "::error::[$TAG] cannot cd to $REPO_DIR"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/push-mutex.sh
source "$SCRIPT_DIR/push-mutex.sh"
push_mutex_acquire
trap 'push_mutex_release' EXIT

write_refused_snapshot() {
  local reason="$1" dirty="$2"
  local behind
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  local node_err
  node_err=$(TAG="$TAG" REASON="$reason" DIRTY="$dirty" BEHIND="$behind" SNAPSHOT_FILE="$SNAPSHOT_FILE" node -e '
    const fs = require("fs");
    fs.mkdirSync("data/audit", { recursive: true });
    const payload = {
      tag: process.env.TAG,
      at: new Date().toISOString(),
      reason: process.env.REASON,
      behindCount: Number(process.env.BEHIND || 0),
      dirtyFiles: (process.env.DIRTY || "").split("\n").filter(Boolean),
    };
    fs.writeFileSync(process.env.SNAPSHOT_FILE, JSON.stringify(payload, null, 2) + "\n");
  ' 2>&1) || echo "::error::[$TAG] failed to write $SNAPSHOT_FILE (the alert itself failed): $node_err"
}

clear_refused_snapshot() {
  rm -f "$SNAPSHOT_FILE" 2>/dev/null || true
}

# unbounded-fetch-ok: this script has NO workflow caller — the guard reaches it
# only transitively and reports it as "reachable from 166 shallow workflow(s)".
# Verified 2026-08-02: `grep -rl sync-audit-checkout .github/workflows/` returns
# nothing; the sole caller is scripts/autonomous-nightly.sh, a local launchd
# script running against the full ~/Broadwayscore clone, never a fetch-depth: 1
# CI checkout. Same justification as scripts/notion-action-poll.js:480. It was
# blocking EVERY session's push through run-push-audits.sh (task #863 class), so
# the waiver is deliberate, not a bypass — if a workflow ever calls this, take
# the flags from scripts/lib/shallow-fetch-args.js and delete this comment.
if ! git fetch origin main --quiet; then
  echo "::error::[$TAG] git fetch origin main failed"
  exit 1
fi

if git merge --ff-only origin/main --quiet 2>/dev/null; then
  clear_refused_snapshot
  exit 0
fi

echo "[$TAG] ff-only blocked — checking for regenerable data/audit/ snapshots to reset..."

DIRTY_AUDIT_FILES=$( (git diff --name-only -- data/audit/; git diff --cached --name-only -- data/audit/) \
  | sort -u | grep -v '\.jsonl$' || true)

if [ -n "$DIRTY_AUDIT_FILES" ]; then
  echo "[$TAG] resetting regenerable snapshot(s):"
  echo "$DIRTY_AUDIT_FILES" | sed "s/^/[$TAG]   /"
  # `checkout HEAD --` (not bare `checkout --`) so this clears BOTH the
  # index and the working tree — a degraded run that crashed after `git add`
  # but before `git commit` leaves the file staged, and a bare `checkout --`
  # only resets working-tree-vs-index, silently no-op'ing against a staged
  # diff and leaving the merge blocked (caught in review, task #732).
  echo "$DIRTY_AUDIT_FILES" | xargs -I{} git checkout HEAD -- "{}"
fi

# UNTRACKED regenerable snapshots (review finding, task #1563): a crashed
# prior run can leave a brand-new file under data/audit/ that was never
# `git add`ed, so `git diff`/`git diff --cached` above never see it. If
# origin/main is about to add that same path, ff-only fails with "untracked
# working tree files would be overwritten" — a case `git diff` is blind to
# by definition. Same safety contract as the tracked case: non-jsonl only.
UNTRACKED_AUDIT_FILES=$(git status --porcelain --untracked-files=all -- data/audit/ 2>/dev/null \
  | awk '/^\?\? /{print substr($0,4)}' | grep -v '\.jsonl$' || true)
if [ -n "$UNTRACKED_AUDIT_FILES" ]; then
  echo "[$TAG] removing untracked regenerable snapshot(s):"
  echo "$UNTRACKED_AUDIT_FILES" | sed "s/^/[$TAG]   /"
  echo "$UNTRACKED_AUDIT_FILES" | xargs -I{} rm -f -- "{}"
fi

if git merge --ff-only origin/main --quiet 2>/dev/null; then
  echo "[$TAG] recovered — fast-forwarded to origin/main after snapshot reset"
  clear_refused_snapshot
  exit 0
fi

# Includes untracked files (review finding: a colliding untracked path
# blocks ff-only just as surely as a tracked dirty one, and excluding it
# here mislabeled that case as bare "diverged"). `cut -c4-` strips the
# porcelain v1 "XY " status prefix rather than `awk '{print $2}'`, which
# grabbed the wrong token for a rename entry ("R  old -> new" -> $2 is
# "old", a path that may no longer exist); the trailing sed keeps the NEW
# side of any rename.
REMAINING_DIRTY=$(git status --porcelain --untracked-files=all 2>/dev/null | cut -c4- | sed 's/.* -> //')
if [ -z "$REMAINING_DIRTY" ]; then
  # Clean tree, still can't ff-only — real commit divergence, no dirty file
  # to blame (a bare `echo "" | grep -v` would otherwise false-match here).
  REASON="diverged"
elif echo "$REMAINING_DIRTY" | grep -qv '^data/audit/'; then
  REASON="dirty-outside-audit"
elif echo "$REMAINING_DIRTY" | grep -q '\.jsonl$'; then
  REASON="dirty-jsonl-ledger"
else
  REASON="dirty-unresolved"
fi

echo "::error::[$TAG] ff-only merge still blocked after snapshot reset — real divergence or dirty files outside data/audit/. Refusing to run on stale code."
echo "::error::[$TAG] investigate: git -C '$REPO_DIR' status --short; git -C '$REPO_DIR' rev-list --count HEAD..origin/main"
write_refused_snapshot "$REASON" "$REMAINING_DIRTY"
exit 1

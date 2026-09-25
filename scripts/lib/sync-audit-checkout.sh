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
#   3. If it STILL can't fast-forward, work out which dirty paths can even
#      block a fast-forward — only the ones origin/main actually moves — and
#      if every one of them is a tracked ledger declared `merge=union` in
#      .gitattributes, union-recover it: save it, clean it, fast-forward,
#      then union the saved rows back on top of origin's version (BRO-2314).
#   4. If the checkout is DIVERGED (a local commit origin lacks, so ff-only
#      can never succeed) but every path still blocking is that same kind of
#      union-safe ledger, commit the dirty ledger(s) `[skip ci]` and
#      `git rebase origin/main` — a real 3-way merge, unlike ff-only, DOES
#      invoke the `merge=union` driver, so the ledger conflict auto-resolves
#      (BRO-3212). Abort and fall through to step 5 on any other rebase
#      failure.
#   5. Otherwise FAIL LOUDLY (exit 1) instead of letting the caller fall
#      through to stale code, naming the file that actually blocked the merge.
#      Callers that chain with `&&` (the launchd inline pattern) get this for
#      free.
#
# WHY STEP 3 EXISTS (BRO-2314): step 2 deliberately never resets a *.jsonl,
# because those are append-only ledgers holding real local rows. Correct, but
# terminal — data/audit/stage-latency.jsonl and scraper-spend-ledger.jsonl are
# appended by local jobs continuously AND moved by CI on origin/main many
# times a day, so ff-only stayed blocked permanently and this gate refused
# every single run for six days (2026-08-20 → 2026-08-26), parking
# com.broadwayscore.predispatch-queue-audit and backlog-drain with it. The
# refusal was even rendered in the morning digest and went unactioned, so more
# alerting was never the fix. Both of those files are already declared
# `merge=union` in .gitattributes precisely because concatenating both sides
# is the lossless resolution for a bot-written append log; step 3 applies that
# same resolution at the point a fast-forward needs it, since a fast-forward
# rewrites the path wholesale and never invokes a merge driver.
#
# WHY STEP 4 EXISTS (BRO-3212): step 3's recovery only ever attempts
# `git merge --ff-only`, which by definition cannot land when the checkout is
# genuinely diverged (aheadCount > 0) — so classifyBlock refused unconditionally
# whenever a local commit existed, EVEN if the only paths that commit touched
# were the same union-safe ledgers step 3 already knows how to reconcile. A
# launchd checkout that appends to a ledger and commits it locally (or is left
# one commit ahead by an interrupted recovery) is diverged in exactly that
# harmless way, and the ledgers regenerate every tick — so the refusal never
# cleared on its own. digest/predispatch-queue-audit/linear-drain-parked/
# weekly-retro/bro1794-merge3 all accumulated divergence for days this way,
# reflected in every Morning Digest as "didn't update overnight" since
# ~2026-09-06. Step 4 commits the dirty ledger(s) so they stop being loose
# working-tree state, then `git rebase origin/main` — a real 3-way merge DOES
# invoke `.gitattributes` merge drivers (unlike ff-only), so the `merge=union`
# ledger conflict auto-resolves the same way `git merge` already handles it.
# Any other rebase failure aborts back to the pre-rebase state and falls
# through to the ordinary loud refusal — this only ever short-circuits the
# case that was ALWAYS safe to resolve, never a genuine content conflict.
#
# WHAT PUSHES THE RESULTING COMMIT (/code-review finding, BRO-3212): this
# script NEVER pushes — none of the seven launchd/cron callers of this file
# do either. The "chore: sync audit ledgers" commit reaches origin
# opportunistically, the next time ANY worktree session runs
# merge-worktree-to-main.sh against this same MAIN_DIR (it merges+pushes
# whatever is on local main, so it sweeps this commit up for free). This is
# an acceptable, self-limiting wait, not a new "sits forever" risk: local
# main was already ahead-until-the-next-merge for ordinary worktree work
# before this change, active sessions merge every ~30 min per CLAUDE.md, and
# even in a long gap with zero merges the worst case is more local-only
# commits piling up (still correct content, just later to origin) — never
# data loss, and strictly better than the pre-fix permanent refusal.
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
  local reason="$1" dirty="$2" blocking="${3:-}"
  local behind
  behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
  local node_err
  node_err=$(TAG="$TAG" REASON="$reason" DIRTY="$dirty" BLOCKING="$blocking" BEHIND="$behind" SNAPSHOT_FILE="$SNAPSHOT_FILE" node -e '
    const fs = require("fs");
    fs.mkdirSync("data/audit", { recursive: true });
    const payload = {
      tag: process.env.TAG,
      at: new Date().toISOString(),
      reason: process.env.REASON,
      behindCount: Number(process.env.BEHIND || 0),
      dirtyFiles: (process.env.DIRTY || "").split("\n").filter(Boolean),
      // The subset of dirtyFiles that origin/main actually moves, i.e. the
      // ONLY files that can block a fast-forward (BRO-2314). dirtyFiles is
      // kept as-is because digest-snapshots.js and its test read the old
      // payload shape; blockingFiles is the one you investigate.
      blockingFiles: (process.env.BLOCKING || "").split("\n").filter(Boolean),
    };
    fs.writeFileSync(process.env.SNAPSHOT_FILE, JSON.stringify(payload, null, 2) + "\n");
  ' 2>&1) || echo "::error::[$TAG] failed to write $SNAPSHOT_FILE (the alert itself failed): $node_err"
}

clear_refused_snapshot() {
  rm -f "$SNAPSHOT_FILE" 2>/dev/null || true
}

# BRO-4141 (W1): every step below — self-healing an interrupted rebase/merge,
# replaying ledger backups, fast-forward, rebase — mutates whatever branch is
# checked out. This runs unattended every 30 min (checkout-sync.plist), so if
# a session ever leaves ~/Broadwayscore on a feature branch (possibly mid-
# conflict-resolution), touching it would destroy their work. Refuse BEFORE
# any mutation unless the checkout is on main. Mid-rebase HEAD is detached,
# so read the branch being rebased from the rebase state dir.
CUR_BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
if [ -z "$CUR_BRANCH" ]; then
  for d in rebase-merge rebase-apply; do
    hn="$(git rev-parse --git-path "$d/head-name" 2>/dev/null)"
    [ -f "$hn" ] && CUR_BRANCH="$(sed 's#^refs/heads/##' "$hn")" && break
  done
fi
CUR_BRANCH="${CUR_BRANCH:-(detached)}"
if [ "$CUR_BRANCH" != "main" ]; then
  echo "::error::[$TAG] checkout is on '$CUR_BRANCH', not main — refusing to sync (would move a non-main branch)"
  write_refused_snapshot "not-on-main:$CUR_BRANCH" "" ""
  exit 1
fi

# ── merge=union ledger recovery scaffolding (BRO-2314) ───────────────────────
# Backups of a dirty append-only ledger, taken for the few hundred ms the
# ledger has to be clean for `git merge --ff-only` to run. They live under the
# GIT COMMON DIR, deliberately NOT under data/audit/, for two reasons:
#   * this script's own untracked-snapshot cleanup above `rm -f`s every
#     untracked non-jsonl path under data/audit/, which would delete the very
#     backup that crash recovery depends on — with green tests, because the
#     tests would never crash;
#   * it is outside every worktree, so it can never itself become a new
#     ff-only blocker. Same reasoning as push-mutex.sh's lock location.
LEDGER_BACKUP_DIR="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)"
case "$LEDGER_BACKUP_DIR" in
  /*) ;;
  *) LEDGER_BACKUP_DIR="$(cd "$LEDGER_BACKUP_DIR" 2>/dev/null && pwd)" ;;
esac
LEDGER_BACKUP_DIR="${LEDGER_BACKUP_DIR}/sync-ledger-backups"

# Backup filenames encode the ledger path (with '/' as '%', a character no
# path here contains) AND the owning PID. The PID is load-bearing: several
# launchd jobs share this gate and push_mutex_acquire FAILS OPEN on timeout,
# so two instances really can be inside the recovery stage at once. Draining
# by name alone would let instance B union-and-delete instance A's backup
# while A is still mid-merge, and A's restore would then find nothing — the
# local ledger would be permanently the truncated origin copy. Only backups
# whose owner is gone (`kill -0` fails) are drained.
ledger_backup_path() { printf '%s/%s.%s.bak' "$LEDGER_BACKUP_DIR" "$(printf '%s' "$1" | tr '/' '%')" "$2"; }

union_restore_ledger() {
  # $1 = ledger path (repo-relative), $2 = backup file
  local target="$1" backup="$2"
  TARGET="$target" BACKUP="$backup" TAG="$TAG" DECISION_LIB="$SCRIPT_DIR/sync-audit-decision.js" node -e '
    const fs = require("fs");
    const { unionLedgerLines, stripTornTrailingLine, unionIsSafe } = require(process.env.DECISION_LIB);
    const readLines = (p) => {
      let raw; try { raw = fs.readFileSync(p, "utf8"); } catch { return null; }
      const lines = raw.split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      return lines;
    };
    const target = process.env.TARGET, backup = process.env.BACKUP, tag = process.env.TAG;
    const base = readLines(target) || [];
    const saved = readLines(backup);
    if (saved === null) { console.error(`::error::[${tag}] backup missing for ${target}`); process.exit(1); }
    const { lines: extra, dropped } = stripTornTrailingLine(saved);
    if (dropped !== null) console.log(`[${tag}]   dropped a torn trailing line from the saved copy of ${target}`);
    const { merged, stats } = unionLedgerLines(base, extra);
    if (!unionIsSafe({ mergedCount: merged.length, baseCount: base.length, extraCount: extra.length })) {
      console.error(`::error::[${tag}] union of ${target} would shrink it (${merged.length} < max(${base.length}, ${extra.length})) — refusing`);
      process.exit(1);
    }
    // Atomic write: a partial write here would leave a ledger that neither
    // the backup nor origin can fully reconstruct — the next run drain can
    // only re-add the LOCAL rows, never the origin-side ones. rename(2)
    // within the same directory is atomic, so a reader or appender sees
    // either the old file or the complete new one, never a truncated one.
    const tmp = `${target}.sync-tmp.${process.pid}`;
    fs.writeFileSync(tmp, merged.length ? merged.join("\n") + "\n" : "");
    fs.renameSync(tmp, target);
    console.log(`[${tag}]   ${target}: ${stats.base} line(s) from origin + ${stats.added} local-only = ${stats.total}`);
  '
}

# Was this path STAGED before we touched it? `git checkout HEAD -- <p>` clears
# the index entry as well as the working tree, and a plain `cp` restore only
# puts the bytes back — so without this, a recovery (or a failed recovery)
# would silently unstage another session's `git add`ed ledger. The existing
# regenerable-snapshot reset at the top of this script already had to learn
# the index/worktree distinction the hard way (task #732).
ledger_was_staged() { ! git diff --cached --quiet -- "$1" 2>/dev/null; }

# Self-heal a rebase left mid-flight (BRO-3212 review finding): the new
# commit-and-rebase stage below can be killed (launchd timeout — the header's
# own known failure mode) between `git commit` succeeding and `git rebase
# --abort` completing, leaving `.git/rebase-merge` (or `rebase-apply` for the
# am-based backend) on disk. Every git command below — even the very first
# `git merge --ff-only` — fails against a checkout mid-rebase, so without this
# the next run would cascade through the whole recovery pipeline into the loud
# refusal every single time: exactly the "refuses forever" failure mode this
# script exists to close, reintroduced via the new code path. Checked before
# Stage 0's ledger-backup drain so nothing else touches the repo first.
REBASE_STATE_DIR="$(git rev-parse --git-path rebase-merge 2>/dev/null)"
if [ -z "$REBASE_STATE_DIR" ] || [ ! -d "$REBASE_STATE_DIR" ]; then
  REBASE_STATE_DIR="$(git rev-parse --git-path rebase-apply 2>/dev/null)"
fi
if [ -n "$REBASE_STATE_DIR" ] && [ -d "$REBASE_STATE_DIR" ]; then
  echo "[$TAG] found a rebase left mid-flight by an interrupted run — aborting to self-heal"
  git rebase --abort 2>/dev/null \
    || echo "::error::[$TAG] git rebase --abort failed while self-healing a stuck rebase at $REBASE_STATE_DIR — investigate by hand"
fi

# The same self-heal for a MERGE left mid-flight (ship-check finding,
# BRO-3393). The merge-origin recovery at the bottom of this script can be
# killed by a launchd timeout between `git merge` and `git merge --abort`, and
# its own abort can fail — either way `MERGE_HEAD` survives on disk. Without
# this, the recovery's own MERGE_HEAD guard REFUSES on every subsequent run
# instead of healing, which is the "refuses forever" failure mode BRO-3212
# wrote the rebase self-heal above for, reintroduced through the merge path.
# Reproduced against this script: after a killed merge, three consecutive runs
# all ended with MERGE_HEAD still present and a refusal snapshot.
#
# The blast radius is why this is worth its own stage: a checkout stuck
# mid-merge breaks EVERY other session sharing it ("Committing is not possible
# because you have unmerged files"), not just this job.
#
# `git ls-files -u` is checked as well as MERGE_HEAD: the autostash-pop
# conflict case leaves unmerged index entries with NO MERGE_HEAD at all, and
# `git merge --abort` cannot help there — those paths get resolved back to
# HEAD, with whatever was in them preserved in the stash entry the merge made.
if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
  echo "[$TAG] found a merge left mid-flight by an interrupted run — aborting to self-heal"
  git merge --abort 2>/dev/null \
    || echo "::error::[$TAG] git merge --abort failed while self-healing a stuck merge — investigate by hand"
fi
STALE_UNMERGED=$(git ls-files -u | cut -f2- | sort -u)
if [ -n "$STALE_UNMERGED" ]; then
  echo "::error::[$TAG] found unmerged index entries with no merge in progress (interrupted autostash restore) — resolving to HEAD to unblock every session sharing this checkout:"
  echo "$STALE_UNMERGED" | sed "s/^/[$TAG]   /"
  while IFS= read -r U; do
    [ -n "$U" ] || continue
    git checkout HEAD -- "$U" 2>/dev/null \
      || echo "::error::[$TAG] could not resolve $U — investigate by hand"
  done <<EOF
$STALE_UNMERGED
EOF
  echo "::error::[$TAG] if any of that content was a live edit it is in a stash entry: git stash list; git stash show -p stash@{0}"
fi

# Stage 0: a previous run that was killed between "clean the ledger" and
# "union the local rows back in" leaves its local rows ONLY in its backup.
# Drain those before touching anything else. Unioning into the live file never
# truncates it, so this is idempotent and safe against a backup of any age.
#
# A backup is only ever applied to a path that is STILL tracked and STILL
# declared merge=union — the filename is an untrusted input (a stale or
# hand-dropped .bak could otherwise name any repo-relative path and have this
# script write to it), and a path that lost its union attribute is no longer
# safe to concatenate.
if [ -d "$LEDGER_BACKUP_DIR" ]; then
  for bak in "$LEDGER_BACKUP_DIR"/*.bak; do
    [ -e "$bak" ] || continue
    base=$(basename "$bak" .bak)
    pid="${base##*.}"
    rel=$(printf '%s' "${base%.*}" | tr '%' '/')
    # Owner still alive → its own restore will handle it. The mtime fallback
    # covers PID reuse: a recovery lasts seconds, so a backup older than an
    # hour whose PID now resolves to some unrelated long-lived process would
    # otherwise sit undrained forever, silently withholding those rows.
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -z "$(find "$bak" -mmin +60 2>/dev/null)" ]; then
      continue
    fi
    # A backup older than a day must NOT be replayed. These ledgers are ring
    # buffers (provider-telemetry.js:69 keeps the newest 20,000 lines), so
    # appending day-old rows makes rows rotation already discarded the
    # "newest" and displaces genuinely newer ones on the next rotate —
    # a corruption unionIsSafe cannot see because the count only grows.
    # Park it instead: nothing is destroyed, nothing is replayed, and the
    # error prints once rather than every run (found in pre-ship review).
    if [ -n "$(find "$bak" -mmin +1440 2>/dev/null)" ]; then
      mv "$bak" "$bak.stale" 2>/dev/null \
        && echo "::error::[$TAG] $bak is over a day old — too stale to union into a rotating ledger. Parked at $bak.stale; apply by hand if those rows matter."
      continue
    fi
    if ! git ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
      echo "::error::[$TAG] backup $bak names an untracked path ($rel) — refusing to write it; move it aside by hand"
      continue
    fi
    case "$rel" in *.jsonl) : ;; *)
      echo "::error::[$TAG] backup $bak names a non-jsonl path ($rel) — refusing to union it; move it aside by hand"
      continue ;;
    esac
    if [ "$(git check-attr merge -- "$rel" 2>/dev/null | sed 's/.*: //')" != "union" ]; then
      echo "::error::[$TAG] backup $bak names $rel, which is no longer merge=union — refusing to union it; move it aside by hand"
      continue
    fi
    echo "[$TAG] draining orphaned ledger backup from pid $pid: $rel"
    if union_restore_ledger "$rel" "$bak"; then
      rm -f "$bak" || echo "::error::[$TAG] drained $bak but could not remove it — it will be re-applied next run"
    else
      echo "::error::[$TAG] could not drain $bak — leaving it in place for the next run"
    fi
  done
fi

# unbounded-fetch-ok: this script has NO workflow caller — the guard reaches it
# only transitively and reports it as "reachable from 166 shallow workflow(s)".
# Verified 2026-08-02: `grep -rl sync-audit-checkout .github/workflows/` returns
# nothing; the sole caller is scripts/autonomous-nightly.sh, a local launchd
# script running against the full ~/Broadwayscore clone, never a fetch-depth: 1
# CI checkout. Same justification as scripts/notion-action-poll.js:480. It was
# blocking EVERY session's push through run-push-audits.sh (task #863 class), so
# the waiver is deliberate, not a bypass — if a workflow ever calls this, take
# the flags from scripts/lib/shallow-fetch-args.js and delete this comment.
# W4: this fetch runs while holding the push mutex; a hung fetch would block
# every other session's push. Hard wall-clock deadline via perl alarm (macOS
# has no coreutils `timeout`; SIGALRM kills git), plus git's own low-speed
# abort for a stalled socket. A timed-out fetch takes the fetch-failed path.
SYNC_FETCH_DEADLINE_SEC="${SYNC_FETCH_DEADLINE_SEC:-180}"
# unbounded-fetch-ok: local launchd/full-clone only, no workflow caller (waiver above).
if ! perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$SYNC_FETCH_DEADLINE_SEC" git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch origin main --quiet; then
  # Must leave a refusal snapshot (ship-check finding, BRO-3393). This exit
  # used to be silent, and morning-digest.plist runs the digest with `;` even
  # when this script fails - so a failed fetch produced NO sync-refused-digest
  # .json, the digest saw "nobody refused", and it filed cards and dispatched
  # headless sessions against a checkout whose freshness had just proven
  # unverifiable. That is exactly the state this machine was in at 10:30 on
  # 2026-09-15, when an Xcode license failure broke git for every job.
  echo "::error::[$TAG] git fetch origin main failed"
  write_refused_snapshot "fetch-failed" "" ""
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
  # A .jsonl ledger staged as gone from data/audit/ — whatever produced that:
  # a plain `git rm`, a rename paired as `R` (git only reports `R` when the
  # destination is a pure addition — a destination that already exists at
  # HEAD shows as unpaired `M`+`D` instead, verified empirically), or a
  # rename bundled with enough content edit that similarity detection
  # reports it as separate `D`+`A`/`M` lines — means this run cannot tell
  # whether some OTHER path in DIRTY_AUDIT_FILES actually holds that
  # ledger's real rows under a new name (ship-check adversarial findings,
  # BRO-2364). Refuse to auto-touch ANY data/audit/ snapshot this run rather
  # than risk discarding real ledger data; the ordinary loud refusal below
  # still names what's blocking. Checking every `[RD]` status line this way
  # (rather than pairing rename sides/destinations one by one) catches all
  # three shapes with one query. Scoped to `-- data/audit/` deliberately, not
  # the whole repo: data/opening-night-timeline/*.jsonl and others get
  # legitimately deleted with zero connection to an audit ledger, and
  # refusing on those would be a NEW instance of the exact "refuses forever"
  # failure mode this whole file exists to close — the tradeoff is that a
  # rename whose SOURCE lives outside data/audit/ is not caught here (no code
  # in this repo does that today; tracked as a residual risk, BRO-3594).
  # `awk -F'\t'`, not the default whitespace split: --name-status is strictly
  # tab-delimited, and a path containing a space would otherwise silently
  # fail to match (verified empirically).
  JSONL_GONE=$(git diff --cached --name-status -- data/audit/ 2>/dev/null \
    | awk -F'\t' '$1 ~ /^[RD]/ && $2 ~ /\.jsonl$/ {print $2}')
  if [ -n "$JSONL_GONE" ]; then
    echo "::error::[$TAG] a .jsonl ledger under data/audit/ is staged as deleted/renamed — refusing to auto-clear any snapshot this run, investigate by hand:"
    echo "$JSONL_GONE" | sed "s/^/[$TAG]   /"
  else
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if git cat-file -e "HEAD:$f" 2>/dev/null; then
        # `checkout HEAD --` (not bare `checkout --`) so this clears BOTH the
        # index and the working tree — a degraded run that crashed after
        # `git add` but before `git commit` leaves the file staged, and a
        # bare `checkout --` only resets working-tree-vs-index, silently
        # no-op'ing against a staged diff and leaving the merge blocked
        # (caught in review, task #732).
        git checkout HEAD -- "$f" \
          || echo "::error::[$TAG] could not reset $f to HEAD"
      else
        # BRO-2364: HEAD has no such path (a NEWLY-ADDED snapshot: a crashed
        # job ran `git add` on a brand-new file but never committed it), so
        # `git checkout HEAD -- "$f"` errors ("did not match any file(s)
        # known to git") and leaves it staged forever — that error was
        # previously swallowed by `xargs`, so the merge stayed permanently
        # blocked with no visible cause. There is nothing at HEAD to
        # restore, so unstage it and delete the working-tree copy instead,
        # same as the untracked case below. Only delete on a successful
        # unstage (ship-check finding) — if `git reset` itself fails (e.g. a
        # lock held by a concurrent process), leave the file exactly as
        # found rather than removing its content while it is still staged.
        if git reset -q -- "$f" 2>/dev/null; then
          rm -f -- "$f" \
            || echo "::error::[$TAG] could not remove newly-added $f"
        else
          echo "::error::[$TAG] could not unstage $f — leaving it staged for the next run"
        fi
      fi
    done <<EOF
$DIRTY_AUDIT_FILES
EOF
  fi
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

# Only the dirty paths origin/main ACTUALLY MOVES can block a fast-forward
# (BRO-2314). `git diff --name-only HEAD origin/main` also lists a path
# origin ADDS that exists locally only as an untracked file, which is the
# case test.sh case 7 covers, so the intersection stays complete.
ORIGIN_CHANGED=$(git diff --name-only HEAD origin/main 2>/dev/null)
AHEAD_COUNT=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
# BRO-3393: classifyBlock needs BOTH sides to tell "diverged and recoverable
# by a plain merge" from "ahead with an unreadable/unmoved origin ref", which
# must still refuse. write_refused_snapshot already computes the same number
# for its own payload; this is the decision copy, taken at decision time.
BEHIND_COUNT=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)

# Which of the blocking paths are safe to reconcile by concatenation?
# .gitattributes is the single source of truth — `merge=union` is already
# declared for data/audit/stage-latency.jsonl and scraper-spend-ledger.jsonl
# with a header comment stating union is the lossless resolution for these
# bot-written append logs. A hardcoded filename list here would drift from it.
# TRACKED-only: `git checkout HEAD -- <p>` has nothing to restore for a path
# HEAD does not contain, so an untracked union-attributed path must refuse.
UNION_PATHS=""
if [ -n "$REMAINING_DIRTY" ]; then
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 || continue
    # merge=union alone is NOT enough. .gitattributes also marks
    # tests/unit-test-manifest.txt and data/opening-night-timeline/*.jsonl as
    # union, and for a manifest a union RESURRECTS a line origin deliberately
    # deleted — union is only the right resolution for a file where every line
    # is an independent appended event that nothing ever removes. Requiring
    # *.jsonl as well keeps this stage on the append-only ledgers it was built
    # for (found in pre-ship review).
    case "$p" in *.jsonl) : ;; *) continue ;; esac
    attr=$(git check-attr merge -- "$p" 2>/dev/null | sed 's/.*: //')
    [ "$attr" = "union" ] || continue
    # The decision is carried to node as newline-joined text and back as
    # pipe-joined text, and backup filenames encode '/' as '%'. A path holding
    # '|' or '%', or with edge whitespace that the transport would trim, cannot
    # round-trip faithfully — and a mis-decoded path is a write to the wrong
    # file. None of the real ledgers look like this; if one ever does, it falls
    # through to the ordinary refusal rather than being silently mangled.
    case "$p" in
      *"|"*|*"%"*|" "*|*" ") echo "::error::[$TAG] $p cannot be safely round-tripped by the recovery stage — refusing it"; continue ;;
    esac
    UNION_PATHS="${UNION_PATHS}${p}\n"
  done <<EOF
$REMAINING_DIRTY
EOF
  UNION_PATHS=$(printf '%b' "$UNION_PATHS")
fi

# One node call returns the whole decision; the logic lives in
# scripts/lib/sync-audit-decision.js so it is unit-testable (CLAUDE.md r15).
DECISION=$(DIRTY="$REMAINING_DIRTY" CHANGED="$ORIGIN_CHANGED" AHEAD="$AHEAD_COUNT" BEHIND="$BEHIND_COUNT" UNION="$UNION_PATHS" DECISION_LIB="$SCRIPT_DIR/sync-audit-decision.js" node -e '
  const { ffBlockingPaths, classifyBlock } = require(process.env.DECISION_LIB);
  const split = (v) => (v || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const blockingPaths = ffBlockingPaths({
    dirtyPaths: split(process.env.DIRTY),
    originChangedPaths: split(process.env.CHANGED),
  });
  const d = classifyBlock({
    blockingPaths,
    aheadCount: Number(process.env.AHEAD || 0),
    behindCount: Number(process.env.BEHIND || 0),
    unionMergePaths: split(process.env.UNION),
  });
  process.stdout.write([d.action, d.reason, d.blockingPaths.join("|"), d.unionPaths.join("|")].join("\n"));
') || DECISION=$'refuse\ndirty-unresolved\n\n'

ACTION=$(printf '%s' "$DECISION" | sed -n '1p')
REASON=$(printf '%s' "$DECISION" | sed -n '2p')
BLOCKING=$(printf '%s' "$DECISION" | sed -n '3p' | tr '|' '\n')
UNION_BLOCKING=$(printf '%s' "$DECISION" | sed -n '4p' | tr '|' '\n')

if [ "$ACTION" = "union-recover" ] && [ -n "$UNION_BLOCKING" ]; then
  # Every remaining blocker is a tracked, merge=union append-only ledger.
  # Save each one, clean it so the fast-forward can write it, then union the
  # saved rows back on top of origin's version. The result is a strict
  # SUPERSET of what origin committed, so whoever commits the ledger next
  # adds rows and deletes none, and the tree ends dirty on exactly the files
  # it was dirty on before.
  echo "[$TAG] ff-only blocked only by merge=union append-only ledger(s) — recovering:"
  echo "$UNION_BLOCKING" | sed "s/^/[$TAG]   /"
  mkdir -p "$LEDGER_BACKUP_DIR"
  BACKUP_OK=1
  STAGED_LEDGERS=""
  while IFS= read -r L; do
    [ -n "$L" ] || continue
    ledger_was_staged "$L" && STAGED_LEDGERS="${STAGED_LEDGERS}${L}
"
    cp "$L" "$(ledger_backup_path "$L" "$$")" || { BACKUP_OK=0; break; }
  done <<EOF
$UNION_BLOCKING
EOF

  if [ "$BACKUP_OK" -eq 1 ]; then
    while IFS= read -r L; do
      [ -n "$L" ] || continue
      git checkout HEAD -- "$L" || BACKUP_OK=0
    done <<EOF
$UNION_BLOCKING
EOF
  fi

  if [ "$BACKUP_OK" -eq 1 ] && git merge --ff-only origin/main --quiet 2>/dev/null; then
    RESTORE_OK=1
    while IFS= read -r L; do
      [ -n "$L" ] || continue
      B="$(ledger_backup_path "$L" "$$")"
      if ! union_restore_ledger "$L" "$B"; then
        RESTORE_OK=0
        # Do not leave THIS ledger sitting at origin-only content until the
        # next launchd tick drains it — anything that reads it, or `git add
        # -A`s it, in the meantime sees the short version. Put the local rows
        # back verbatim now; the backup stays so the drain can still reconcile.
        [ -f "$B" ] && { cp "$B" "$L" || echo "::error::[$TAG] FAILED to restore $L from $B — restore it by hand"; }
      fi
    done <<EOF
$UNION_BLOCKING
EOF
    if [ "$RESTORE_OK" -eq 1 ]; then
      # Put back any index entry `git checkout HEAD --` cleared, so another
      # session's staged ledger is not silently unstaged by this gate.
      while IFS= read -r L; do
        [ -n "$L" ] || continue
        git add -- "$L" || echo "::error::[$TAG] could not re-stage $L after recovery"
      done <<EOF
$STAGED_LEDGERS
EOF
      while IFS= read -r L; do
        [ -n "$L" ] || continue
        rm -f "$(ledger_backup_path "$L" "$$")" \
          || echo "::error::[$TAG] could not remove backup for $L — the next run will re-apply it (harmless: union is idempotent)"
      done <<EOF
$UNION_BLOCKING
EOF
      echo "[$TAG] recovered — fast-forwarded to origin/main, union-restored $(echo "$UNION_BLOCKING" | grep -c . ) ledger(s)"
      clear_refused_snapshot
      exit 0
    fi
    # Restore failed: leave the backups on disk. Stage 0 of the next run
    # drains them, so no local row is stranded, and we refuse rather than
    # claim a recovery that did not complete.
    echo "::error::[$TAG] union restore failed — backups left in $LEDGER_BACKUP_DIR for the next run to drain"
    REASON="dirty-unresolved"
  else
    # Could not clean or could not merge. Put every ledger back byte-for-byte
    # and fall through to the normal refusal — never leave a truncated ledger.
    ROLLBACK_OK=1
    while IFS= read -r L; do
      [ -n "$L" ] || continue
      B="$(ledger_backup_path "$L" "$$")"
      [ -f "$B" ] || continue
      if cp "$B" "$L"; then
        rm -f "$B" || echo "::error::[$TAG] restored $L but could not remove its backup"
      else
        ROLLBACK_OK=0
        echo "::error::[$TAG] FAILED to restore $L from $B — the backup is intact, restore it by hand"
      fi
    done <<EOF
$UNION_BLOCKING
EOF
    while IFS= read -r L; do
      [ -n "$L" ] || continue
      git add -- "$L" || echo "::error::[$TAG] could not re-stage $L after rollback"
    done <<EOF
$STAGED_LEDGERS
EOF
    if [ "$ROLLBACK_OK" -eq 1 ]; then
      echo "::error::[$TAG] merge=union ledger recovery could not complete — ledgers restored verbatim"
    else
      echo "::error::[$TAG] merge=union ledger recovery could not complete AND rollback was incomplete — see the FAILED lines above"
    fi
    REASON="dirty-unresolved"
  fi
fi

if [ "$ACTION" = "commit-and-rebase" ] && [ -n "$UNION_BLOCKING" ]; then
  # Diverged (a local commit origin lacks), but every path still blocking a
  # fast-forward is a tracked, merge=union append-only ledger (BRO-3212).
  # ff-only can never land here — commit the dirty ledger(s) so they stop
  # being working-tree state, then rebase onto origin/main. A rebase performs
  # a real 3-way merge per commit, which DOES invoke `.gitattributes` merge
  # drivers (unlike ff-only), so the ledger conflict auto-resolves via the
  # `union` driver exactly as it would for `git merge`.
  echo "[$TAG] diverged, but every blocker is a merge=union append-only ledger — committing and rebasing:"
  echo "$UNION_BLOCKING" | sed "s/^/[$TAG]   /"
  STAGE_OK=1
  STAGED_NOW=""
  while IFS= read -r L; do
    [ -n "$L" ] || continue
    if git add -- "$L"; then
      STAGED_NOW="${STAGED_NOW}${L}
"
    else
      STAGE_OK=0
    fi
  done <<EOF
$UNION_BLOCKING
EOF

  # A partial staging failure must not leave a half-`git add`ed ledger sitting
  # in the index below — every other exit path in this script promises the
  # tree is left exactly as it was found (review finding, BRO-3212).
  if [ "$STAGE_OK" -ne 1 ] && [ -n "$STAGED_NOW" ]; then
    echo "$STAGED_NOW" | while IFS= read -r L; do
      [ -n "$L" ] || continue
      git restore --staged -- "$L" 2>/dev/null || git reset -q -- "$L" 2>/dev/null || true
    done
  fi

  # `--only -- <paths>` (review finding, BRO-3212): a bare `git commit` with no
  # pathspec commits the ENTIRE index, not just what the loop above staged —
  # under push_mutex_acquire's documented fail-open-on-timeout, a concurrent
  # session sharing this checkout could have unrelated changes already staged,
  # and this commit must never sweep those in. `--only` restricts the commit
  # to exactly $UNION_BLOCKING even if something else is sitting in the index.
  if [ "$STAGE_OK" -eq 1 ] \
       && git commit --no-verify -q --only -m "chore: sync audit ledgers [skip ci]" -- $UNION_BLOCKING; then
    # --autostash (review finding, BRO-3212): `--only` above deliberately
    # leaves any OTHER staged/unstaged content in the working tree untouched
    # (never swept into the ledger commit — see the comment above), but plain
    # `git rebase` refuses to even START against a non-clean tree, regardless
    # of whether that content conflicts with anything being replayed.
    # --autostash stashes it, runs the rebase, and restores it afterward —
    # git-native, so it correctly handles both the success and failure paths
    # (including restoring the stash if the rebase itself is aborted below).
    if git rebase --autostash origin/main --quiet 2>/dev/null; then
      echo "[$TAG] recovered — committed local ledger append(s) and rebased onto origin/main"
      clear_refused_snapshot
      exit 0
    fi
    echo "::error::[$TAG] rebase onto origin/main failed after committing the ledger(s) — aborting rebase, ledger commit preserved locally for the next run to carry forward (git status will look clean; see git log -1 / merge-worktree-to-main.sh)"
    git rebase --abort 2>/dev/null || echo "::error::[$TAG] git rebase --abort itself failed — checkout may be mid-rebase, investigate by hand"
  else
    echo "::error::[$TAG] could not commit the ledger(s) for rebase recovery"
  fi
  REASON="dirty-unresolved"
fi

# BRO-3393. Diverged (a local commit origin lacks) with ZERO paths blocking
# the fast-forward. Before this branch that was terminal, and it is the state
# BRO-3212's own commit-and-rebase recovery leaves behind whenever its rebase
# fails ("ledger commit preserved locally for the next run to carry forward"
# — nothing carried it forward). On 2026-09-14 that stranded a single ledger
# commit on the shared main checkout and every sync-gated launchd job refused
# for the next 17.5 hours, which forced the 07:30 morning digest's auto-fix
# into dry-run and dispatched nothing.
#
# MERGE, NOT REBASE. `git rebase origin/main` here would rewrite arbitrary
# local commits — including an unpushed session merge commit, verified
# empirically to be DESTROYED by the rebase (its side commits survive with
# fresh SHAs, the merge itself does not). That is the loss class global
# CLAUDE.md records for 2026-07-26. A merge never rewrites local history, and
# unlike `--ff-only` it performs a real 3-way merge, so `.gitattributes`
# merge=union drivers apply exactly as they do in the commit-and-rebase path.
# The existing rebase at the commit-and-rebase branch above is not a precedent
# for rebasing here either. It is reached only when every ff-blocking path is a
# union ledger, i.e. the narrow case where the divergence is known to be
# ledger-shaped; it still replays whatever other local commits exist, which is
# a hazard that branch carries and this one must not copy (ship-check finding).
#
# --autostash: `git merge` refuses to start against a tree with staged or
# modified tracked content even when the merge would not touch those paths.
# --autostash is git-native and restores the content on both the success and
# the failure path. It does NOT stash untracked files — safe here because this
# branch only runs when $BLOCKING is empty, i.e. no dirty TRACKED-or-UNTRACKED
# path overlaps what origin/main moves. IGNORED paths are the one gap: they
# never appear in `git status --porcelain -uall` and so never reach
# blockingPaths, so a gitignored local file at a path origin/main adds is
# overwritten silently. That is pre-existing for the plain ff-only merge at the
# top of this script, not new here, and it is tracked separately.
if [ "$ACTION" = "merge-origin" ]; then
  # GUARD 1 - exclusive ownership. push_mutex_acquire FAILS OPEN on timeout
  # (push-mutex.sh:153-157 returns success with PUSH_MUTEX_HELD=0), so without
  # this check two instances could run this branch at once, and the loser's
  # unconditional `git merge --abort` would abort the WINNER's merge
  # (ship-check finding, BRO-3393). Recovery mutates shared history; it is the
  # one thing in this script that must not proceed fail-open.
  if [ "${PUSH_MUTEX_HELD:-0}" != "1" ]; then
    echo "::error::[$TAG] diverged and recoverable, but the push mutex was not exclusively held (fail-open timeout) — refusing to mutate the shared checkout"
    REASON="diverged"
  # GUARD 2 - somebody else is already mid-merge. `git merge --abort` below
  # must only ever undo OUR merge, so establish that there is no merge in
  # progress before we start one.
  elif git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    echo "::error::[$TAG] a merge is already in progress in this checkout (MERGE_HEAD present) — refusing to touch it"
    REASON="diverged"
  else
    echo "[$TAG] diverged with nothing blocking the fast-forward ($AHEAD_COUNT ahead, $BEHIND_COUNT behind) — reconciling with a 3-way merge of origin/main"
    if git merge --autostash --no-edit origin/main --quiet 2>/dev/null; then
      # GUARD 3 - a 0 exit is NOT proof the tree is clean. Verified
      # empirically: when the merge itself succeeds but restoring the
      # --autostash CONFLICTS, git prints "Applying autostash resulted in
      # conflicts", exits 0, removes MERGE_HEAD, and leaves the working tree
      # with `UU` unmerged paths plus a stranded `autostash` stash entry.
      # Reporting that as "recovered" would hand every downstream launchd job
      # a checkout with conflict markers in tracked files (ship-check finding,
      # BRO-3393). Resolve the paths back to the merged commit - the local
      # content is not lost, it is in the stash entry named below - and refuse,
      # because the tree is no longer the one the caller expected.
      # `cut -f2-`, not `awk '{print $4}'` (ship-check finding): ls-files -u
      # prints `<mode> <sha> <stage>\t<path>`, so awk's whitespace split
      # truncates `data/foo bar.json` to `data/foo`. The checkout below would
      # then fail, the unmerged entry would survive, and the checkout would be
      # left in exactly the permanently-blocked state the self-heal above
      # exists to prevent.
      UNMERGED=$(git ls-files -u | cut -f2- | sort -u)
      if [ -n "$UNMERGED" ]; then
        echo "::error::[$TAG] merge landed but restoring the autostash conflicted — resolving these paths back to the merged commit:"
        echo "$UNMERGED" | sed "s/^/[$TAG]   /"
        while IFS= read -r U; do
          [ -n "$U" ] || continue
          git checkout HEAD -- "$U" 2>/dev/null \
            || echo "::error::[$TAG] could not restore $U to the merged commit — resolve by hand"
        done <<EOF
$UNMERGED
EOF
        echo "::error::[$TAG] the working-tree content that conflicted is SAFE in the most recent 'autostash' entry — inspect with: git stash list; git stash show -p stash@{0}"
        # Its own reason, not "diverged" (ship-check finding): the merge DID
        # land, so behindCount is 0 by now and a snapshot saying
        # `diverged — 0 commit(s) behind` reads as a contradiction in the
        # owner's morning email.
        REASON="autostash-conflict"
      else
        echo "[$TAG] recovered — merged origin/main into the local checkout"
        clear_refused_snapshot
        exit 0
      fi
    else
      echo "::error::[$TAG] merge of origin/main failed — aborting and refusing rather than leaving a half-merged shared checkout"
      if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
        git merge --abort 2>/dev/null || echo "::error::[$TAG] git merge --abort itself failed — checkout may be mid-merge, investigate by hand"
      fi
      REASON="diverged"
    fi
  fi
fi

echo "::error::[$TAG] ff-only merge still blocked after snapshot reset — real divergence or dirty files outside data/audit/. Refusing to run on stale code."
if [ -n "$BLOCKING" ]; then
  echo "::error::[$TAG] blocked by (dirty AND moved by origin/main): $(echo "$BLOCKING" | tr '\n' ' ')"
fi
echo "::error::[$TAG] investigate: git -C '$REPO_DIR' status --short; git -C '$REPO_DIR' rev-list --count HEAD..origin/main"
write_refused_snapshot "$REASON" "$REMAINING_DIRTY" "$BLOCKING"
exit 1

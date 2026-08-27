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
#   4. Otherwise FAIL LOUDLY (exit 1) instead of letting the caller fall
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

# Only the dirty paths origin/main ACTUALLY MOVES can block a fast-forward
# (BRO-2314). `git diff --name-only HEAD origin/main` also lists a path
# origin ADDS that exists locally only as an untracked file, which is the
# case test.sh case 7 covers, so the intersection stays complete.
ORIGIN_CHANGED=$(git diff --name-only HEAD origin/main 2>/dev/null)
AHEAD_COUNT=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)

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
DECISION=$(DIRTY="$REMAINING_DIRTY" CHANGED="$ORIGIN_CHANGED" AHEAD="$AHEAD_COUNT" UNION="$UNION_PATHS" DECISION_LIB="$SCRIPT_DIR/sync-audit-decision.js" node -e '
  const { ffBlockingPaths, classifyBlock } = require(process.env.DECISION_LIB);
  const split = (v) => (v || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const blockingPaths = ffBlockingPaths({
    dirtyPaths: split(process.env.DIRTY),
    originChangedPaths: split(process.env.CHANGED),
  });
  const d = classifyBlock({
    blockingPaths,
    aheadCount: Number(process.env.AHEAD || 0),
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

echo "::error::[$TAG] ff-only merge still blocked after snapshot reset — real divergence or dirty files outside data/audit/. Refusing to run on stale code."
if [ -n "$BLOCKING" ]; then
  echo "::error::[$TAG] blocked by (dirty AND moved by origin/main): $(echo "$BLOCKING" | tr '\n' ' ')"
fi
echo "::error::[$TAG] investigate: git -C '$REPO_DIR' status --short; git -C '$REPO_DIR' rev-list --count HEAD..origin/main"
write_refused_snapshot "$REASON" "$REMAINING_DIRTY" "$BLOCKING"
exit 1

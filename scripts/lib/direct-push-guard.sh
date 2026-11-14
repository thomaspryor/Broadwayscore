#!/usr/bin/env bash
# direct-push-guard.sh — the refusal decision behind scripts/hooks/pre-push's
# "no direct pushes to main" rule (BRO-3425 / BRO-3873 step 5).
#
# Sessions land through scripts/merge-worktree-to-main.sh, which pushes the
# branch to land/<branch> and lets .github/workflows/land.yml run the gates
# and fast-forward main. A session's interactive `git push origin main`
# (or `git push origin HEAD:main`) bypasses every one of those gates, so the
# repo's pre-push hook refuses it. Bots keep their direct push:
#
#   allow:ci                   $GITHUB_ACTIONS or $CI is set (land.yml's own
#                              push, every workflow's push-with-retry.sh)
#   allow:push-with-retry-bot  PUSH_WITH_RETRY_CALLER=bot — exported by
#                              scripts/lib/push-with-retry.sh itself (launchd
#                              daemons, autonomous runners). A SESSION typing
#                              push-with-retry.sh by hand is stopped earlier by
#                              the ~/.claude PreToolUse gate, not here.
#   allow:LAND_LEGACY_DIRECT   LAND_LEGACY_DIRECT=1 — the merge script's
#                              rollback-only legacy mode (logged)
#   allow:LAND_ENFORCE_OFF     LAND_ENFORCE_OFF=1 — hook kill switch (logged)
#   allow:not-main             destination is not refs/heads/main|master
#   allow:data-only            the push changes NO code path (see
#                              DIRECT_PUSH_CODE_PATH_RE — the worktree-mandatory
#                              scope from CLAUDE.md rule 1: src/, scripts/,
#                              .github/workflows/, supabase/, top-level config,
#                              CLAUDE.md). Mac-side automation pushes data,
#                              cloud-memory and review-text commits to main
#                              with a bare `git push` (sync-memory-to-repo.sh
#                              at session stop, fix-review-file.sh,
#                              sync-review-texts.sh, …) — land.yml's gates are
#                              for CODE, so those keep flowing (not logged:
#                              that is every session's stop hook).
#   refuse                     everything else
#
#   direct_push_guard_decision <remote_ref> [<changed-paths-file>]
#     the optional file lists the paths the push changes (remote..local),
#     one per line; without it a main-bound push is judged as code.
#
# Logged (direct_push_guard_log): every refusal, and every flag/actor allow.
# NOT logged: allow:ci (rows would only ever live on a runner) and
# allow:push-with-retry-bot (the launchd daemons push many times a day —
# that is the ledger's noise floor, not a signal).
#
# Pure: reads only its argument and the environment. Sourced by the hook;
# exercised end to end by scripts/lib/direct-push-guard.test.mjs.

DIRECT_PUSH_REFUSAL_MESSAGE='land via scripts/merge-worktree-to-main.sh (land/** branch) — direct pushes to main are refused (BRO-3425)'
# Keep in step with CODE_PATH_RE in scripts/lib/landings-ledger.js (the
# detector's copy of the same scope) and the worktree-mandatory list in
# ~/.claude/hooks/worktree-enforce.sh.
DIRECT_PUSH_CODE_PATH_RE='^(src/|scripts/|supabase/|\.github/workflows/|CLAUDE\.md$|next\.config\.(js|ts|mjs)$|tsconfig\.json$|package\.json$|package-lock\.json$)'

# direct_push_guard_touches_code <changed-paths-file> → 0 if any path is code
direct_push_guard_touches_code() {
  local f="${1:-}"
  [ -n "$f" ] && [ -f "$f" ] || return 0   # unknown change set → judged as code
  grep -qE "$DIRECT_PUSH_CODE_PATH_RE" "$f"
}

direct_push_guard_decision() {
  local remote_ref="${1:-}" changed="${2:-}"
  case "$remote_ref" in
    refs/heads/main|refs/heads/master) ;;
    *) echo "allow:not-main"; return 0 ;;
  esac
  if [ "${LAND_ENFORCE_OFF:-}" = "1" ]; then echo "allow:LAND_ENFORCE_OFF"; return 0; fi
  if [ -n "${GITHUB_ACTIONS:-}" ] || { [ -n "${CI:-}" ] && [ "${CI:-}" != "false" ] && [ "${CI:-}" != "0" ]; }; then
    echo "allow:ci"; return 0
  fi
  if [ "${PUSH_WITH_RETRY_CALLER:-}" = "bot" ]; then echo "allow:push-with-retry-bot"; return 0; fi
  if [ "${LAND_LEGACY_DIRECT:-}" = "1" ]; then echo "allow:LAND_LEGACY_DIRECT"; return 0; fi
  if [ -n "$changed" ] && [ -f "$changed" ] && [ -s "$changed" ] && ! direct_push_guard_touches_code "$changed"; then
    echo "allow:data-only"; return 0
  fi
  echo "refuse"
  return 0
}

# direct_push_guard_log <decision> <remote_ref> <local_oid> <repo_root>
# Appends one row to the canonical dispatch ledger
# (<git-common-dir>/../data/audit/dispatch-ledger.jsonl — gitignored,
# Mac-local) so every refusal and every flag-allowed direct push is
# auditable next to the dispatch rows. Uses scripts/lib/dispatch-ledger.js's
# appendEntry when the lib is present (same ts/validation rules as every
# other row), a plain JSON line otherwise. Best effort — never fails a push.
# Skipped inside CI (allow:ci) — those rows would only ever live on a runner.
direct_push_guard_log() {
  local decision="${1:-}" remote_ref="${2:-}" local_oid="${3:-}" repo_root="${4:-}"
  [ "$decision" = "allow:ci" ] && return 0
  [ "$decision" = "allow:not-main" ] && return 0
  [ "$decision" = "allow:push-with-retry-bot" ] && return 0
  [ "$decision" = "allow:data-only" ] && return 0
  [ -n "$repo_root" ] || return 0
  local common canonical ledger event
  common=$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null) || return 0
  case "$common" in
    /*) canonical=$(dirname "$common") ;;
    *)  canonical=$(cd "$repo_root/$common/.." 2>/dev/null && pwd) ;;
  esac
  [ -n "$canonical" ] || return 0
  ledger="${DIRECT_PUSH_LEDGER_PATH:-$canonical/data/audit/dispatch-ledger.jsonl}"
  case "$decision" in
    refuse) event="direct-push-refused" ;;
    *)      event="direct-push-allowed" ;;
  esac
  local branch cwd_now
  branch=$(git -C "$repo_root" branch --show-current 2>/dev/null || true)
  cwd_now=$(pwd)
  if command -v node >/dev/null 2>&1 && [ -f "$canonical/scripts/lib/dispatch-ledger.js" ]; then
    DPG_EVENT="$event" DPG_DECISION="$decision" DPG_REF="$remote_ref" DPG_OID="$local_oid" \
    DPG_BRANCH="$branch" DPG_CWD="$cwd_now" DPG_LEDGER="$ledger" DPG_LIB="$canonical/scripts/lib/dispatch-ledger.js" \
    node -e '
      try {
        const { appendEntry } = require(process.env.DPG_LIB);
        appendEntry({
          event: process.env.DPG_EVENT, taskId: "direct-push", source: "scripts/hooks/pre-push",
          decision: process.env.DPG_DECISION, remoteRef: process.env.DPG_REF, localOid: process.env.DPG_OID,
          branch: process.env.DPG_BRANCH || null, cwd: process.env.DPG_CWD, user: process.env.USER || null,
        }, process.env.DPG_LEDGER);
      } catch (e) { process.exit(0); }
    ' >/dev/null 2>&1 || true
  else
    mkdir -p "$(dirname "$ledger")" 2>/dev/null || true
    local j_branch j_cwd
    if command -v jq >/dev/null 2>&1; then
      j_branch=$(printf '%s' "$branch" | jq -Rs . 2>/dev/null || echo '""')
      j_cwd=$(printf '%s' "$cwd_now" | jq -Rs . 2>/dev/null || echo '""')
    else
      j_branch="\"$(printf '%s' "$branch" | tr -d '"\\')\""
      j_cwd="\"$(printf '%s' "$cwd_now" | tr -d '"\\')\""
    fi
    printf '{"ts":"%s","event":"%s","taskId":"direct-push","source":"scripts/hooks/pre-push","decision":"%s","remoteRef":"%s","localOid":"%s","branch":%s,"cwd":%s}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" "$decision" "$remote_ref" "$local_oid" "$j_branch" "$j_cwd" \
      >> "$ledger" 2>/dev/null || true
  fi
  return 0
}

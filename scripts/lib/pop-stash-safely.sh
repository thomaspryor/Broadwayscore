#!/usr/bin/env bash
# Sourced helper. Caller supplies g(), log(), and MAIN_DIR.

# pop_stash_safely — pops exactly one stash (stash@{0}) with the conflict-
# safety rules below. Shared by restore_stash() (the top-of-script stash,
# popped at the very end) and the push-retry loop's own tightly-scoped
# re-stash (BRO-2552) — both need the identical safety net, not two copies
# that can drift apart. Captures the stash's SHA FRESH, right before
# attempting the pop, rather than trusting a value computed earlier: by the
# time this runs, index-based `stash@{0}` references may have shifted (a
# concurrent session's own stash push/pop on the SAME shared checkout,
# ship-check finding, task #888/BRO-253), so only a SHA read at the moment of
# the pop attempt is guaranteed to name the entry this call is operating on.
# Returns 0 after a clean pop or auto-resolution, 1 for a non-auto-gen merge
# conflict. A failed pop always retains the stash for recovery (BRO-3938).
pop_stash_safely() {
  local STASH_SHA
  STASH_SHA=$(g rev-parse -q --verify stash@{0} 2>/dev/null || echo "")
  if ! g stash pop >/dev/null 2>&1; then
    # A failed pop may not have applied ANY stashed paths, especially while
    # MERGE_HEAD is set. Resolving auto-gen conflicts does not prove that the
    # stash's unrelated content was restored. Only Git's successful pop may
    # drop the entry; retain it on every failure, even with no unmerged paths.
    local recover_hint="git -C $MAIN_DIR stash list"
    [ -n "$STASH_SHA" ] && recover_hint="git -C $MAIN_DIR stash show -p $STASH_SHA"
    log "⚠ stash pop failed: KEEPING the stash entry for recovery. Recover with: $recover_hint"
    # This fallback used to assume stash-pop conflicts are ALWAYS in auto-
    # generated state files and blindly `checkout HEAD -- .` across the WHOLE
    # working tree. That's wrong whenever this fires while `git merge $BRANCH`
    # (above) is itself mid-conflict: the conflicted path is then the branch's
    # REAL change, and `checkout HEAD -- .` silently overwrites it with main's
    # stale content — merge reports "resolve manually" but the file has
    # already been wrongly "resolved" underneath that message (task #888,
    # 2026-08-02: scripts/lib/sync-audit-checkout.sh's real fix was discarded
    # this way).
    #
    # The real signal for "is there branch content at risk here" is whether a
    # `git merge` is actually mid-conflict (MERGE_HEAD present), NOT a static
    # path allowlist — this repo's local daemon churns far more than
    # cloud-memory/, data/audit/, public/data/admin/ (e.g. public/data/shows/
    # is `merge-coverage=exempt` in .gitattributes and among the highest-churn
    # dirs in the repo). A path-allowlist that's too narrow would make
    # ORDINARY daemon churn take the "leave it alone" branch below and wedge
    # the shared main worktree for every session until an operator manually
    # intervenes — trading one silent-wrong-content bug for a
    # blocks-everyone-on-routine-churn bug. So: no MERGE_HEAD means nothing
    # here is a genuine branch merge conflict.
    #
    # BUT `git stash pop` conflicts NEVER set MERGE_HEAD — that marker is
    # `git merge`-specific, so this branch is also reached for a stash-pop
    # conflict that has nothing to do with any `git merge` at all (e.g. this
    # session's stashed content collides with what origin/$DEFAULT_BRANCH
    # just merged in, a concurrent-push race, not "daemon churn"). Verified
    # live: a `git stash pop` conflict against another session's genuine
    # uncommitted WIP shows up here with MERGE_HEAD absent every time
    # (BRO-253, 2026-08-11 — a real session's edit to a core script was wiped
    # this way, with zero trace, while the script reported success). So a
    # full `reset --hard HEAD` here is NOT provably lossless the way the
    # daemon-churn case assumes — resolve the WORKING TREE (so the shared
    # checkout isn't wedged) but do NOT `stash drop`: keep the stash entry so
    # real content, if any was lost, is still recoverable via `git stash
    # list` / `git stash show -p` instead of gone for good.
    if ! g rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
      # Same "was there actually a conflict" check the MERGE_HEAD branch
      # below already does (ship-check finding): `git stash pop` can fail
      # for reasons that leave nothing unmerged (a lock, a transient ref
      # error). Leave both the working tree and the unapplied stash intact.
      if [ -z "$(g diff --name-only --diff-filter=U 2>/dev/null)" ]; then
        return 0
      fi
      log "⚠ stash pop conflicted with no merge in progress — resetting working tree (reset --hard HEAD) but KEEPING the stash entry in case the conflicting content was real (not daemon churn). Recover with: $recover_hint"
      g reset --hard HEAD >/dev/null 2>&1 || true
      return 0
    fi
    # MERGE_HEAD is set: `git merge $BRANCH` above is genuinely mid-conflict
    # and the stash-pop conflict landed on top of it. Only auto-resolve paths
    # we can PROVE are the known daemon-churn set; anything else, leave
    # untouched and fail loudly so the genuine merge conflict stays visible
    # instead of being papered over.
    local unmerged unsafe
    unmerged=$(g diff --name-only --diff-filter=U 2>/dev/null)
    if [ -z "$unmerged" ]; then
      # Nothing to auto-resolve. The failed pop still needs its recovery copy.
      return 0
    fi
    unsafe=""
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      case "$f" in
        # *.jsonl append-only ledgers are NEVER auto-resolved here, even under
        # cloud-memory/data/audit/public/data/admin — same policy as
        # scripts/lib/sync-audit-checkout.sh (BRO-2364), which refuses
        # snapshot cleanup on any ledger staged as deleted/renamed rather than
        # risk truncating rows a union-merge could otherwise preserve
        # (ship-check/Codex adversarial finding, BRO-3595: this loop's
        # HEAD-missing-path fallback below would otherwise `rm -f` a ledger
        # whose content only exists on $BRANCH's commit, discarding it
        # instead of leaving it for manual/union resolution).
        *.jsonl) unsafe+="$f"$'\n' ;;
        cloud-memory/*|data/audit/*|public/data/admin/*) ;;
        *) unsafe+="$f"$'\n' ;;
      esac
    done <<< "$unmerged"
    if [ -n "$unsafe" ]; then
      log "⚠ stash pop conflicted on non-auto-gen path(s) mid-merge — NOT auto-resolving (would risk silently discarding the real merge conflict, see task #888):"
      echo "$unsafe" | sed 's/^/    /' >&2
      return 1
    fi
    log "stash pop conflicted on auto-gen files only — taking committed version for those paths"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if g cat-file -e "HEAD:$f" 2>/dev/null; then
        g checkout HEAD -- "$f" >/dev/null 2>&1 \
          || log "⚠ could not reset $f to HEAD during stash-pop auto-resolution"
      else
        # BRO-3595 (same class as BRO-2364/sync-audit-checkout.sh:397-424):
        # HEAD has no such path — a newly-added auto-gen file (e.g. a brand-new
        # data/audit/*.json snapshot, or a cloud-memory file the background
        # daemon wrote independently after the stash was taken). `git checkout
        # HEAD -- "$f"` errors ("did not match any file(s) known to git") here,
        # which used to be swallowed by `|| true` with no log line, leaving the
        # path unresolved in the index while `g stash drop` still ran and the
        # content was gone for good. Nothing at HEAD to restore, so unstage and
        # remove the working-tree copy instead.
        if g reset -q -- "$f" >/dev/null 2>&1; then
          rm -f -- "$MAIN_DIR/$f" \
            || log "⚠ could not remove newly-added $f during stash-pop auto-resolution"
        else
          log "⚠ could not unstage newly-added $f during stash-pop auto-resolution — leaving it staged"
        fi
      fi
    done <<< "$unmerged"
  fi
}

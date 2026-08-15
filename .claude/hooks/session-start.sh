#!/bin/bash

# Self-skip if the user-level master hook exists (local CLI scenario).
# Cloud sandboxes do not have ~/.claude/hooks/, so the project copy runs there.
# Avoids double-firing identical logic on local sessions where the user-level
# Claude Code settings.json already wires the master at ~/.claude/hooks/<this-script-name>.
if [ -f "$HOME/.claude/hooks/$(basename "$0")" ]; then
  exit 0
fi
# Session-start hook: injects critical rules as additionalContext
# Modeled after Superpowers' using-superpowers meta-skill

# Capture event type from stdin (JSON). Fall back to "startup" if stdin is empty
# or jq isn't available. We gate the staleness check on startup-only so /clear
# and /compact don't trigger redundant network fetches mid-session.
SESSION_INPUT=$(cat 2>/dev/null || true)
if [ -z "$SESSION_INPUT" ]; then
  SESSION_EVENT="startup"
else
  SESSION_EVENT=$(echo "$SESSION_INPUT" | jq -r '.source // "startup"' 2>/dev/null)
  [ -z "$SESSION_EVENT" ] && SESSION_EVENT="startup"
fi

# Auto-pull claude-config (silent, non-blocking — if it fails, session continues)
if [ -x "$HOME/.claude/bin/claude-sync" ]; then
  "$HOME/.claude/bin/claude-sync" pull >/dev/null 2>&1 || true
fi

# Reap any zombie `gh` polling loops from prior/parallel sessions BEFORE they
# burn the GitHub rate limit. PreToolUse blocks new ones; this catches the
# ones that slipped through (older sessions, crashed sessions). 2026-05-23.
if [ -x "$HOME/.claude/hooks/gh-zombie-reap.sh" ]; then
  "$HOME/.claude/hooks/gh-zombie-reap.sh" 2>&1 || true
fi

# Integrity check: verify critical CLAUDE.md anchor phrases haven't been reverted.
# Source of truth: <repo>/scripts/lib/claude-md-anchors.json (also a blocking CI
# gate in test.yml lint-workflows). Fail-soft: if the JSON or node is unavailable,
# fall back to the built-in phrase list; this block never aborts session start.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/CLAUDE.md" ]; then
  ANCHORS_JSON="$REPO_ROOT/scripts/lib/claude-md-anchors.json"
  PHRASES=""
  if [ -f "$ANCHORS_JSON" ] && command -v node >/dev/null 2>&1; then
    PHRASES=$(node -e 'try{const a=require(process.argv[1]).anchors||[];process.stdout.write(a.join("\n"))}catch(e){}' "$ANCHORS_JSON" 2>/dev/null || true)
  fi
  # Fallback to the built-in list if the JSON yielded nothing (older checkout,
  # parse error, node missing) — keeps the check working everywhere.
  [ -z "$PHRASES" ] && PHRASES=$'Notion Brain\nOpening Night Readiness\nTest Extraction Pattern\nEmail Broadcast Safety'
  MISSING=""
  while IFS= read -r phrase; do
    [ -z "$phrase" ] && continue
    grep -qF "$phrase" "$REPO_ROOT/CLAUDE.md" || MISSING="$MISSING [$phrase]"
  done <<< "$PHRASES"
  if [ -n "$MISSING" ]; then
    echo ""
    echo "!!! CLAUDE.md INTEGRITY FAILURE — required anchor(s) missing:$MISSING"
    echo "!!! Fix IMMEDIATELY: re-apply from git history before doing ANY other work."
    echo ""
  fi
fi

# Load-time size check. Both files load into every session as system context.
# Line limits alone are gamed by long lines — check BOTH line count AND byte size.
# MEMORY.md: 180 lines / 20KB. CLAUDE.md: 150 lines / 12KB. Caps grew silently
# to 345 lines / 23KB before being noticed (2026-05-08), then again to 206/23KB by
# 2026-06-05 because this warning is advisory and got ignored (warning fatigue).
# MEMORY.md is now hard-enforced at WRITE time by memory-index-cap-guard.sh
# (PreToolUse) — this warning is the secondary/visibility layer for CLAUDE.md and
# for catching drift from non-Edit/Write writers (e.g. rebuild-memory-index.js).
if [ -n "$REPO_ROOT" ]; then
  CLAUDE_FILE="$REPO_ROOT/CLAUDE.md"
  CLAUDE_LINE_LIMIT=150
  CLAUDE_BYTES_LIMIT=14336  # 14KB (~3.5K tokens) — don't grow; trim at next /wrap-up
  if [ -f "$CLAUDE_FILE" ]; then
    CLAUDE_LINES=$(wc -l < "$CLAUDE_FILE" | tr -d ' ')
    CLAUDE_BYTES=$(wc -c < "$CLAUDE_FILE" | tr -d ' ')
    if [ "${CLAUDE_LINES:-0}" -gt "$CLAUDE_LINE_LIMIT" ]; then
      echo ""
      echo "🔶 CLAUDE.md is $CLAUDE_LINES lines (cap: $CLAUDE_LINE_LIMIT). Trim before next /wrap-up."
      echo ""
    fi
    if [ "${CLAUDE_BYTES:-0}" -gt "$CLAUDE_BYTES_LIMIT" ]; then
      echo ""
      echo "🔶 CLAUDE.md is ${CLAUDE_BYTES}B (~$((CLAUDE_BYTES/4)) tokens, limit: 12KB)."
      echo "   Line count doesn't capture density — trim descriptions, move detail to memory/."
      echo ""
    fi
  fi

  # MEMORY.md is per-project at ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md
  ENCODED=$(echo "$REPO_ROOT" | sed 's|/|-|g')
  MEMORY_FILE="$HOME/.claude/projects/$ENCODED/memory/MEMORY.md"
  MEMORY_LINE_LIMIT=180
  MEMORY_BYTES_LIMIT=20000  # ~5K tokens; matches memory-index-cap-guard.sh write-time cap
  if [ -f "$MEMORY_FILE" ]; then
    MEMORY_LINES=$(wc -l < "$MEMORY_FILE" | tr -d ' ')
    MEMORY_BYTES=$(wc -c < "$MEMORY_FILE" | tr -d ' ')
    if [ "${MEMORY_LINES:-0}" -gt "$MEMORY_LINE_LIMIT" ]; then
      echo ""
      echo "🔶 MEMORY.md is $MEMORY_LINES lines (cap: $MEMORY_LINE_LIMIT). Harness truncates at ~200."
      echo ""
    fi
    if [ "${MEMORY_BYTES:-0}" -gt "$MEMORY_BYTES_LIMIT" ]; then
      echo ""
      echo "🔶 MEMORY.md is ${MEMORY_BYTES}B (~$((MEMORY_BYTES/4)) tokens, cap: 20KB)."
      echo "   Write-time guard should hold this; if you see it, a non-Edit writer grew it."
      echo "   Trim: each entry = [Title](file.md) — one short hook"
      echo ""
    fi
  fi
fi

# Worktree reminder: if this session is starting in the main repo root (not a
# worktree), and CLAUDE.md is present, surface a prominent reminder to use
# EnterWorktree before any code edits. Added 2026-04-11 after a parallel session
# lost page.tsx/index.ts work to a git hook race. See feedback_worktree_code_changes.md.
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/CLAUDE.md" ]; then
  if [[ "$PWD" != *"/.claude/worktrees/"* ]]; then
    echo ""
    echo "🔶 WORKTREE REMINDER: this session is starting in the MAIN repo, not a worktree."
    echo "   If you'll be editing any tracked code file — src/, scripts/, .github/workflows/,"
    echo "   next.config.js, tsconfig.json, package.json — call EnterWorktree FIRST."
    echo "   Local git hooks and parallel CI commits silently revert uncommitted edits."
    echo "   A parallel session lost page.tsx/index.ts this way on 2026-04-11."
    echo "   Rule: memory/feedback_worktree_code_changes.md"
    echo ""
  fi
fi

# Command-file drift check. The repo mirrors ~/.claude/commands/*.md into
# .claude/commands/ so cloud sessions (no ~/.claude) get the same skills.
# Project copies SHADOW the global ones locally, so drift means local sessions
# silently run a stale skill (2026-07-13: repo wrap-up.md predated #48's
# dispatch-first + self-close phases — sessions never saw them). Canonical rule:
# the two copies must be IDENTICAL; merge best-of-both and copy to both sides.
if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/.claude/commands" ] && [ -d "$HOME/.claude/commands" ]; then
  DRIFTED=""
  for cf in "$REPO_ROOT"/.claude/commands/*.md; do
    [ -f "$cf" ] || continue
    cb=$(basename "$cf")
    gf="$HOME/.claude/commands/$cb"
    if [ -f "$gf" ] && ! cmp -s "$cf" "$gf"; then
      # Direction hint only — claude-sync pull (above) rewrites global mtimes,
      # and -nt is false on ties, so treat this as a starting point, not truth.
      if [ "$cf" -nt "$gf" ]; then
        DRIFTED="$DRIFTED
     $cb (repo copy has newer mtime)"
      elif [ "$gf" -nt "$cf" ]; then
        DRIFTED="$DRIFTED
     $cb (global ~/.claude copy has newer mtime)"
      else
        DRIFTED="$DRIFTED
     $cb (same mtime — inspect the diff)"
      fi
    fi
  done
  if [ -n "$DRIFTED" ]; then
    echo ""
    echo "🔶 COMMAND-FILE DRIFT: repo .claude/commands/ differs from ~/.claude/commands/ —"
    echo "   local sessions load the repo copy, so one side is running a stale skill:$DRIFTED"
    echo "   First check: if the repo copy is just behind origin/main"
    echo "   (git diff origin/main -- .claude/commands/ is non-empty in a stale worktree),"
    echo "   pull/rebase instead of merging. Otherwise fix NOW (worktree for the repo"
    echo "   side): diff each pair, merge best-of-both, make both sides byte-identical,"
    echo "   commit repo + claude-sync push."
    echo ""
  fi
fi

# Hook-file drift check. Same rationale as COMMAND-FILE DRIFT above, applied to
# .claude/hooks/*.sh — added 2026-07-24 (#428) after session-start.sh itself sat
# 141 lines out of sync for months with nothing catching it (the commands/ loop
# above only ever walked .claude/commands/*.md, never hooks/). Cloud sessions
# (no ~/.claude) run ONLY the repo copy, so drift there is a silent capability
# gap, not just a stale-skill nuisance.
# Several repo hooks (session-start.sh, notion-create-block.sh,
# whitespace-nowrap-lint.sh, pre-push-visual-gate.sh, verify-edits.sh — #430)
# intentionally carry a repo-only "# Self-skip ... fi" guard block at the top
# (so local sessions, which load BOTH this global hook AND the repo's
# settings.json-wired copy, don't double-fire) that must never exist in the
# global master copy. Strip that block before comparing so this permanent,
# by-design difference doesn't re-flag every session — a hardcoded per-file
# exception list would need updating by hand every time a new hook adopts the
# convention; stripping the block generically self-heals for future hooks too.
if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/.claude/hooks" ] && [ -d "$HOME/.claude/hooks" ]; then
  HOOK_DRIFTED=""
  for hf in "$REPO_ROOT"/.claude/hooks/*.sh; do
    [ -f "$hf" ] || continue
    hb=$(basename "$hf")
    gh="$HOME/.claude/hooks/$hb"
    if [ -f "$gh" ] && ! diff -q <(sed '/# Self-skip/,/^fi$/d' "$hf") <(sed '/# Self-skip/,/^fi$/d' "$gh") >/dev/null 2>&1; then
      if [ "$hf" -nt "$gh" ]; then
        HOOK_DRIFTED="$HOOK_DRIFTED
     $hb (repo copy has newer mtime)"
      elif [ "$gh" -nt "$hf" ]; then
        HOOK_DRIFTED="$HOOK_DRIFTED
     $hb (global ~/.claude copy has newer mtime)"
      else
        HOOK_DRIFTED="$HOOK_DRIFTED
     $hb (same mtime — inspect the diff)"
      fi
    fi
  done
  if [ -n "$HOOK_DRIFTED" ]; then
    echo ""
    echo "🔶 HOOK-FILE DRIFT: repo .claude/hooks/ differs from ~/.claude/hooks/ —"
    echo "   cloud sessions run ONLY the repo copy, so drift there is a silent"
    echo "   capability gap, not just a stale-skill nuisance:$HOOK_DRIFTED"
    echo "   Merge best-of-both, make both sides identical (repo-only"
    echo "   self-skip guard blocks excepted — see comment above), commit"
    echo "   repo + claude-sync push."
    echo ""
  fi
fi

# Staleness check for private-repo data checkouts (startup event only).
# Pattern: sessions frequently read stale local data, burn context on a bad
# diagnosis, then realize mid-session they need to `git pull`. This check
# surfaces the staleness BEFORE the session's first tool call.
#
# Reuses scripts/sync-review-texts.sh --check-only (added 79bccac7b0) which
# does a 5s-timeout fetch + state reporting without any commits/pushes.
#
# Paths watched (repo | sync-script | label):
#   data/review-texts         → scripts/sync-review-texts.sh      (review-texts)
#   ~/broadway-scorecard-data → (no --check-only helper yet)      (core-data)
#
# Fires on startup AND resume — resume is actually the higher-value case since
# long-running sessions that pause + resume are when local drift matters most.
# Skips /clear and /compact (those fire mid-session and would spam fetches).
# We print to STDOUT (same channel as the CRITICAL RULES banner below) so the
# warning is surfaced via additionalContext, which is empirically guaranteed
# to reach the assistant (system reminder at top of every message).
if { [ "$SESSION_EVENT" = "startup" ] || [ "$SESSION_EVENT" = "resume" ]; } && [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/scripts/sync-review-texts.sh" ]; then
  CHECK_OUT=$(bash "$REPO_ROOT/scripts/sync-review-texts.sh" --check-only 2>/dev/null || true)
  # Parse state=X behind=N ahead=M dirty=Y
  CHECK_STATE=$(echo "$CHECK_OUT" | sed -n 's/.*state=\([a-z]*\).*/\1/p')
  CHECK_BEHIND=$(echo "$CHECK_OUT" | sed -n 's/.*behind=\([0-9]*\).*/\1/p')
  CHECK_AHEAD=$(echo "$CHECK_OUT" | sed -n 's/.*ahead=\([0-9]*\).*/\1/p')
  CHECK_DIRTY=$(echo "$CHECK_OUT" | sed -n 's/.*dirty=\([a-z]*\).*/\1/p')
  # Check signals independently — a dirty tree can ALSO be behind, so we print
  # both warnings when both apply. Only skip when state is clean/nogit/nofetch.
  if [ "$CHECK_STATE" != "clean" ] && [ "$CHECK_STATE" != "nogit" ] && [ "$CHECK_STATE" != "nofetch" ] && [ -n "$CHECK_STATE" ]; then
    if [ "${CHECK_BEHIND:-0}" != "0" ] && [ "${CHECK_AHEAD:-0}" = "0" ] && [ "$CHECK_DIRTY" = "no" ]; then
      echo ""
      echo "🔶 STALE LOCAL DATA: data/review-texts is $CHECK_BEHIND commit(s) behind origin/main."
      echo "   Sessions that read review-texts will see outdated data (this is the #1 cause"
      echo "   of 'why are these files missing?' confusion)."
      echo "   Safe to fast-forward. Run before any read/enrich/audit:"
      echo "     cd data/review-texts && git pull --ff-only origin main"
      echo ""
    elif [ "${CHECK_BEHIND:-0}" = "0" ] && [ "${CHECK_AHEAD:-0}" != "0" ] && [ "$CHECK_DIRTY" = "no" ]; then
      echo ""
      echo "🔶 UNPUSHED LOCAL COMMITS: data/review-texts is $CHECK_AHEAD commit(s) ahead of origin/main."
      echo "   You have local work that hasn't been pushed. Not stale but watch for divergence."
      echo "   Push when ready: cd data/review-texts && bash ../../scripts/lib/push-with-retry.sh"
      echo ""
    elif [ "${CHECK_BEHIND:-0}" != "0" ] && [ "${CHECK_AHEAD:-0}" != "0" ]; then
      echo ""
      echo "🚨 DIVERGED: data/review-texts is $CHECK_BEHIND behind AND $CHECK_AHEAD ahead of origin/main (dirty=$CHECK_DIRTY)."
      echo "   Rebase needed before reading/writing review-texts. Run:"
      echo "     cd data/review-texts && git pull --rebase origin main"
      echo "   If conflicts: resolve with 'checkout --theirs' (CI wins) then rebase --continue."
      echo ""
    elif [ "$CHECK_DIRTY" = "yes" ]; then
      # Pure-dirty case: uncommitted changes (possibly also behind).
      MSG_SUFFIX=""
      if [ "${CHECK_BEHIND:-0}" != "0" ]; then
        MSG_SUFFIX=" AND $CHECK_BEHIND commit(s) behind origin"
      fi
      echo ""
      echo "🔶 DIRTY WORKING TREE: data/review-texts has uncommitted changes${MSG_SUFFIX}."
      echo "   Commit or stash before enrichment/rebuild. See: cd data/review-texts && git status"
      echo ""
    fi
  fi
fi

# Scoring-delta session baseline (added 2026-06-04). data/review-texts is a single
# clone SHARED by all concurrent CMUX sessions, so `scoring-delta.js`'s `git diff
# HEAD` saw the UNION of every session's uncommitted churn and reported dozens of
# "flips" belonging to OTHER sessions (2026-06-01 incident). Snapshot the files
# already dirty at THIS session's start, keyed by CMUX surface id, so scoring-delta
# can exclude pre-existing churn and report only this session's own changes.
# Best-effort, capped, never blocks startup. Read by scripts/scoring-delta.js
# loadSessionBaseline().
RT_DIR="${REPO_ROOT:-}/data/review-texts"
RT_SID="${CMUX_SURFACE_ID:-${CMUX_WORKSPACE_ID:-}}"
if [ -n "$RT_SID" ] && [ -d "$RT_DIR/.git" ]; then
  RT_BASELINE="/tmp/scoring-delta-baseline-${RT_SID}.tsv"
  (
    cd "$RT_DIR" 2>/dev/null || exit 0
    # First 500 already-dirty .json files + their content sha1. 500 covers the
    # realistic churn (≈90 observed); beyond that the un-listed files just fall
    # back to being reported (no worse than before this fix).
    git diff HEAD --name-only 2>/dev/null \
      | grep '\.json$' | head -500 \
      | while IFS= read -r f; do
          [ -f "$f" ] && printf '%s\t%s\n' "$(shasum -a1 "$f" 2>/dev/null | cut -d' ' -f1)" "$f"
        done > "$RT_BASELINE" 2>/dev/null
  ) || true
fi

# Stalled-merge detection (main repo). Added 2026-05-24 after a prior session
# aborted mid-merge and left cloud-memory/MEMORY.md in UU state with no MERGE_HEAD.
# Subsequent sessions inherited the conflict indefinitely; nothing surfaced it.
# `git ls-files -u` lists index entries with stage >0 (unmerged). Combined with
# absence of MERGE_HEAD/REBASE_HEAD/CHERRY_PICK_HEAD = stalled state from a
# crashed/aborted merge. Active merges (MERGE_HEAD present) are intentional and
# skipped — those are the assistant's responsibility to finish.
if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/.git" ]; then
  UNMERGED_COUNT=$(cd "$REPO_ROOT" && git ls-files -u 2>/dev/null | wc -l | tr -d ' ')
  if [ "${UNMERGED_COUNT:-0}" -gt 0 ]; then
    HAS_ACTIVE_OP=no
    for f in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
      [ -e "$REPO_ROOT/.git/$f" ] && HAS_ACTIVE_OP=yes && break
    done
    [ -d "$REPO_ROOT/.git/rebase-merge" ] || [ -d "$REPO_ROOT/.git/rebase-apply" ] && HAS_ACTIVE_OP=yes
    if [ "$HAS_ACTIVE_OP" = "no" ]; then
      UNMERGED_FILES=$(cd "$REPO_ROOT" && git ls-files -u 2>/dev/null | awk '{print $4}' | sort -u | head -5 | sed 's/^/     /')
      echo ""
      echo "🛑 STALLED MERGE STATE: index has $UNMERGED_COUNT conflict entry/entries but no"
      echo "   MERGE_HEAD / REBASE_HEAD / CHERRY_PICK_HEAD. A prior session aborted mid-merge."
      echo "   This persists across sessions until resolved. Fix before any other work:"
      echo "   Unmerged paths:"
      echo "$UNMERGED_FILES"
      echo "   Resolution options:"
      echo "     # accept incoming (theirs) for one file:"
      echo "     git checkout --theirs <path> && git add <path>"
      echo "     # accept local (ours) for one file:"
      echo "     git checkout --ours <path> && git add <path>"
      echo "     # nuclear: drop the conflict and reset that path to HEAD"
      echo "     git reset HEAD <path> && git checkout -- <path>"
      echo ""
    fi
  fi
fi

# Stale-MERGE_HEAD detection on the SHARED MAIN worktree (BRO-142, recurrence
# of #916/#1279/#1445). The block above only fires when THIS session's own
# REPO_ROOT/.git is a directory — true for the main checkout, but false for
# every worktree-launched session (a linked worktree's .git is a FILE), which
# is most sessions on this project per CLAUDE.md's worktree-first rule. That
# left the shared main worktree's own MERGE_HEAD state invisible to exactly
# the sessions most likely to hit it via push-with-retry.sh/merge-worktree-
# to-main.sh. Resolve the main worktree explicitly via `git worktree list` so
# this fires regardless of which worktree the current session is in.
# Read-only: warns only, never mutates — see detect-stale-merge-head.sh's
# header for why auto-recovery was deliberately rejected for v1.
if [ -n "$REPO_ROOT" ]; then
  BRO142_MAIN_DIR=$(cd "$REPO_ROOT" 2>/dev/null && git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
  # Source from the MAIN worktree's copy, not this session's own REPO_ROOT —
  # a worktree branched before this fix landed on main has no such file at
  # $REPO_ROOT even though $BRO142_MAIN_DIR is fully wedged (Codex finding,
  # 2026-08-14 ship-check). Sourcing from main means the fix covers every
  # worktree session the instant it lands, not gradually as each worktree
  # happens to rebase.
  BRO142_LIB="$BRO142_MAIN_DIR/scripts/lib/detect-stale-merge-head.sh"
  if [ -n "$BRO142_MAIN_DIR" ] && [ -d "$BRO142_MAIN_DIR" ] && [ -f "$BRO142_LIB" ]; then
    # shellcheck source=scripts/lib/detect-stale-merge-head.sh
    source "$BRO142_LIB"
    BRO142_RESULT=$(merge_head_staleness "$BRO142_MAIN_DIR" 2>/dev/null)
    BRO142_STATUS="${BRO142_RESULT%% *}"
    if [ "$BRO142_STATUS" = "stale" ]; then
      echo ""
      merge_head_staleness_message "$BRO142_MAIN_DIR" "$BRO142_STATUS" "${BRO142_RESULT#* }"
      echo ""
    fi
  fi
fi

# Conflict-marker check for local data/review-texts. Added 2026-04-26 after a
# session found 287 broken-JSON files (<<<<<<< Updated upstream / >>>>>>> Stashed
# changes) in the local working copy with ZERO in the private repo — local-only
# corruption from past stash/rebase ops that silently drops review-texts from
# every local rebuild. See memory/feedback_local_review_texts_conflict_markers.md.
# PERF NOTE: do NOT use `grep -rl '<<<<<<<' data/review-texts/` — it scans 38k+
# files and takes 22s cold. Use `git status` instead: git tracks merge conflicts
# (UU) and unmerged files already; no full-tree scan needed. 2026-05-17.
if { [ "$SESSION_EVENT" = "startup" ] || [ "$SESSION_EVENT" = "resume" ]; } && [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/data/review-texts/.git" ]; then
  # git status --short lists UU (both-modified/conflict) and AA (both-added) entries
  # which are the only states where conflict markers appear. Instant vs 22s grep.
  CONFLICT_COUNT=$(cd "$REPO_ROOT/data/review-texts" && git status --short 2>/dev/null | grep -cE '^(UU|AA|DD|AU|UA|DU|UD) ' || echo 0)
  if [ "${CONFLICT_COUNT:-0}" -gt 0 ]; then
    echo ""
    echo "🚨 LOCAL JSON CORRUPTION: $CONFLICT_COUNT review-text file(s) in data/review-texts"
    echo "   contain unresolved git conflict markers (<<<<<<< / >>>>>>>). These are"
    echo "   syntactically broken JSON and silently drop from every local rebuild."
    echo "   Likely from a past 'git stash pop' or rebase that wasn't fully resolved."
    echo "   The private repo is the authority — sync from it:"
    echo "     while IFS= read -r f; do"
    echo "       rel=\"\${f#./data/review-texts/}\""
    echo "       [ -f \"\$HOME/broadway-review-texts/\$rel\" ] && cp \"\$HOME/broadway-review-texts/\$rel\" \"\$f\""
    echo "     done < <(grep -rl '<<<<<<<' data/review-texts/)"
    echo "   See memory/feedback_local_review_texts_conflict_markers.md."
    echo ""
  fi
fi

# Stash accumulation guard. Added 2026-07-24 (task #427) after 44 stashes piled
# up on the Broadwayscore main repo over months — sessions run defensive
# `git stash -u -m "..."` to park pre-existing data-file drift before a
# merge/rebase, but nothing ever drains them. One stale autostash left
# unresolved conflict markers directly in data/audit/validation-baseline.json
# on main's working tree and silently blocked merge/checkout for every session
# until found by chance (see Broadwayscore commit 91be6c72fdd). Same bug family
# as the conflict-marker check above. Fires on startup/resume only; cheap
# (`git stash list` is local, no network).
if { [ "$SESSION_EVENT" = "startup" ] || [ "$SESSION_EVENT" = "resume" ]; } && [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/.git" ]; then
  STASH_COUNT=$(git -C "$REPO_ROOT" stash list 2>/dev/null | wc -l | tr -d ' ')
  if [ "${STASH_COUNT:-0}" -gt 10 ]; then
    echo ""
    echo "🔶 STASH BACKLOG: $STASH_COUNT stashes on $(basename "$REPO_ROOT") (threshold: 10)."
    echo "   Unclaimed stashes can silently reintroduce old conflict markers or drift"
    echo "   into the working tree and block merges (blocked a live merge 2026-07-24)."
    echo "   Inspect before dropping: git stash show -p stash@{N}"
    echo "   Data-file/audit/log churn is almost always safe to drop; anything touching"
    echo "   src/ or scripts/ — diff it against current main first (likely already merged)."
    echo ""
  fi
fi

cat << 'EOF'
CRITICAL SESSION RULES (CLAUDE.md has full text — these 6 are the most-violated):
1. NOTION: create card immediately via `node scripts/notion-brain.js create` (CLI, not MCP — MCP is blocked).
2. VERIFY: run the command + show output before claiming done. `node --check` is syntax only, not a test.
3. ASYNC = WAIT: deploys/CI started ≠ done. Verify it succeeded; fix if it failed.
4. FIX, DON'T REPORT: discovered issues get fixed now, not listed for later.
5. KEEP GOING: do natural follow-ups (rebuild, deploy, fix adjacent). Don't offer handoffs to "a new session" — banned phrase list in CLAUDE.md §5.
6. TERSE OUTPUT: short answers, no trailing recap, drop pleasantries. Output tokens cost ~5x input — verbose explanation is the single biggest token leak Claude controls. Verification evidence still required (rule 2); cut narration, keep proof.
Flow: implement → /did-it-work → /ship-check → /wrap-up. Don't stop between skills unless user said stop or you hit a real blocker.
EOF

# ── Self-heal: data-repo pre-commit guards (conflict markers / invalid JSON) ──
# Source of truth: <web repo>/scripts/data-repo-hooks/pre-commit. Installed into
# each local review-texts clone; a re-clone loses .git/hooks, this restores it.
# Origin: 2026-07-11 stash-pop markers committed into 35 files redded main CI.
HOOK_SRC="$HOME/Broadwayscore/scripts/data-repo-hooks/pre-commit"
if [ -f "$HOOK_SRC" ]; then
  for clone in "$HOME/Broadwayscore/data/review-texts" "$HOME/broadway-review-texts"; do
    if [ -d "$clone/.git" ] && ! cmp -s "$HOOK_SRC" "$clone/.git/hooks/pre-commit" 2>/dev/null; then
      cp "$HOOK_SRC" "$clone/.git/hooks/pre-commit" && chmod +x "$clone/.git/hooks/pre-commit"
    fi
  done
fi

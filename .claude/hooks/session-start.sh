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

# Integrity check: verify critical CLAUDE.md sections haven't been reverted
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -f "$REPO_ROOT/CLAUDE.md" ]; then
  MISSING=""
  grep -q "Notion Brain" "$REPO_ROOT/CLAUDE.md" || MISSING="$MISSING [§6 Notion Brain]"
  grep -q "Opening Night Readiness" "$REPO_ROOT/CLAUDE.md" || MISSING="$MISSING [§14 Opening Night]"
  grep -q "Test Extraction Pattern" "$REPO_ROOT/CLAUDE.md" || MISSING="$MISSING [§15 Test Extraction]"
  grep -q "Email Broadcast Safety" "$REPO_ROOT/CLAUDE.md" || MISSING="$MISSING [§16 Email Broadcast]"
  if [ -n "$MISSING" ]; then
    echo ""
    echo "!!! CLAUDE.md INTEGRITY FAILURE — sections silently reverted:$MISSING"
    echo "!!! Fix IMMEDIATELY: re-apply from git history before doing ANY other work."
    echo ""
  fi
fi

# Load-time size check. Both files load into every session as system context.
# MEMORY.md is truncated by the harness at ~200 lines — entries past that are
# paid-for but never seen. CLAUDE.md has a documented 150-line cap. Caps grew
# silently to 345 / 155 before being noticed (2026-05-08). Warn at load so the
# next /wrap-up prunes before re-bloat. SessionStart is the right gate: the
# cost is paid at load time, and per-edit hooks would create warning fatigue
# during the very prune sessions meant to fix this.
if [ -n "$REPO_ROOT" ]; then
  CLAUDE_FILE="$REPO_ROOT/CLAUDE.md"
  CLAUDE_LIMIT=150
  if [ -f "$CLAUDE_FILE" ]; then
    CLAUDE_LINES=$(wc -l < "$CLAUDE_FILE" | tr -d ' ')
    if [ "${CLAUDE_LINES:-0}" -gt "$CLAUDE_LIMIT" ]; then
      echo ""
      echo "🔶 CLAUDE.md is $CLAUDE_LINES lines (documented cap: $CLAUDE_LIMIT)."
      echo "   It loads every session — trim before next /wrap-up. Move detail to memory/."
      echo ""
    fi
  fi

  # MEMORY.md is per-project at ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md
  # The encoding replaces every '/' in cwd with '-'.
  ENCODED=$(echo "$REPO_ROOT" | sed 's|/|-|g')
  MEMORY_FILE="$HOME/.claude/projects/$ENCODED/memory/MEMORY.md"
  MEMORY_LIMIT=180
  if [ -f "$MEMORY_FILE" ]; then
    MEMORY_LINES=$(wc -l < "$MEMORY_FILE" | tr -d ' ')
    if [ "${MEMORY_LINES:-0}" -gt "$MEMORY_LIMIT" ]; then
      echo ""
      echo "🔶 MEMORY.md is $MEMORY_LINES lines (documented cap: $MEMORY_LIMIT)."
      echo "   Harness truncates after ~200 — entries past that load but are unseen."
      echo "   Trim before next /wrap-up or add 'archived: true' frontmatter to older entries,"
      echo "   then: node scripts/rebuild-memory-index.js --enforce-limit=$MEMORY_LIMIT"
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

# Conflict-marker check for local data/review-texts. Added 2026-04-26 after a
# session found 287 broken-JSON files (<<<<<<< Updated upstream / >>>>>>> Stashed
# changes) in the local working copy with ZERO in the private repo — local-only
# corruption from past stash/rebase ops that silently drops review-texts from
# every local rebuild. See memory/feedback_local_review_texts_conflict_markers.md.
# Fast (~1-2s on a warm FS); only fires on startup/resume.
if { [ "$SESSION_EVENT" = "startup" ] || [ "$SESSION_EVENT" = "resume" ]; } && [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/data/review-texts" ]; then
  CONFLICT_COUNT=$(grep -rl '<<<<<<<' "$REPO_ROOT/data/review-texts" 2>/dev/null | wc -l | tr -d ' ')
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
# up on main over months — sessions run defensive `git stash -u -m "..."` to
# park pre-existing data-file drift before a merge/rebase, but nothing ever
# drains them. One stale autostash left unresolved conflict markers directly
# in data/audit/validation-baseline.json on main's working tree and silently
# blocked merge/checkout for every session until found by chance (see commit
# 91be6c72fdd). Fires on startup/resume only; cheap (`git stash list` is local).
if { [ "$SESSION_EVENT" = "startup" ] || [ "$SESSION_EVENT" = "resume" ]; } && [ -n "$REPO_ROOT" ]; then
  STASH_COUNT=$(git -C "$REPO_ROOT" stash list 2>/dev/null | wc -l | tr -d ' ')
  if [ "${STASH_COUNT:-0}" -gt 10 ]; then
    echo ""
    echo "🔶 STASH BACKLOG: $STASH_COUNT stashes on main (threshold: 10)."
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

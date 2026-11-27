#!/usr/bin/env bash
# push-session-llm-usage.sh (BRO-8356): land this Mac's session LLM rows on main.
#
# Every /ship-check, /plan-review and Stop-hook reviewer call a Mac session makes is
# metered into ~/.claude/state/llm-session-usage.jsonl (scripts/lib/gemini-usage-ledger.js
# sessionLedgerPath). CI (the session-spend alarm in check-provider-spend.js, the
# BRO-8160 recheck probe) only sees data/audit/llm-session-usage.jsonl on main, and the
# fold that copies rows there (record-claude-session-cost.js --fold-only) was only a
# prose step in /wrap-up that headless jobs never run: no Mac reviewer row reached main
# from 2026-11-24 on. This job folds and pushes them on a schedule instead
# (scripts/launchd/com.broadwayscore.session-llm-usage-push.plist).
#
# How: a throwaway detached worktree at origin/main, fold the home file into ITS tracked
# ledger (--to, with that worktree's own fold code), commit that one file, push with
# scripts/lib/push-with-retry.sh (bot caller; a data-only push to main). The fold
# dedupes against main's copy, so re-running is a no-op. Never touches the shared
# checkout's working tree. Exit 0 = pushed or nothing to push, 1 = push failed.
set -euo pipefail

[ -z "${GITHUB_ACTIONS:-}" ] || { echo "push-session-llm-usage: CI has no home ledger; nothing to do"; exit 0; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_LEDGER="${LLM_SESSION_LEDGER_PATH:-$HOME/.claude/state/llm-session-usage.jsonl}"
REL=data/audit/llm-session-usage.jsonl
[ -s "$HOME_LEDGER" ] || { echo "push-session-llm-usage: no home ledger at $HOME_LEDGER; nothing to do"; exit 0; }

TMP="$(mktemp -d /tmp/session-llm-usage.XXXXXX)"
WT="$TMP/wt"
cleanup() { git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

git -C "$REPO" fetch -q origin main
git -C "$REPO" worktree add -q --detach "$WT" origin/main
cd "$WT"
# The fold runs from the pinned origin/main tree, never the shared checkout (may be stale).
out="$(LLM_SESSION_LEDGER_PATH="$HOME_LEDGER" node "$WT/scripts/record-claude-session-cost.js" --fold-only --to="$WT/$REL")"
echo "push-session-llm-usage: $out"
# Stage first: a ledger the fold had to create is untracked, which `git diff` would not see.
git add -- "$REL"
if git diff --cached --quiet -- "$REL"; then exit 0; fi
git commit -q --no-verify -m "audit: Mac session LLM usage rows (BRO-8356) [skip ci]" -- "$REL"
bash "$WT/scripts/lib/push-with-retry.sh" 7 main
echo "push-session-llm-usage: pushed $(git rev-parse --short HEAD)"

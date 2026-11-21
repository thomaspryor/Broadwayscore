#!/usr/bin/env bash
# scripts/codex/ensure-cli.sh: make the Codex CLI usable in this container, then
# print one line: READY, or MISSING: <reason>.
#
# BRO-7927: the review skills (/plan-review, /ship-check) checked only
# `command -v codex`, and a fresh cloud container has no Codex, so every cloud
# review quietly fell back to gpt-5.4-mini ("expected in cloud"). Codex does run
# in cloud: the board-workers Codex lane installs it and restores the owner's
# ChatGPT login (scripts/codex/auth-store.js). This script does the same three
# steps for any session, idempotently:
#   1. install @openai/codex at the pinned version when missing or different
#   2. restore the stored login when this container has none (or an older one)
#   3. install the repo's Codex guards into ~/.codex (scripts/codex/install.js)
# Refresh tokens rotate (scripts/codex/daily-runner.js saves after every exec),
# so after each `codex exec` run `--save`, or the stored login goes stale and the
# next container restores a dead token.
# Never prints token material. Exit 0 = READY/SAVED, 1 = MISSING/SAVE-FAILED.
#
# Usage: bash scripts/codex/ensure-cli.sh          # before codex exec
#        bash scripts/codex/ensure-cli.sh --save   # after codex exec

set -u
PIN="${CODEX_CLI_VERSION:-0.160.0}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="${TMPDIR:-/tmp}/codex-ensure.log"
: > "$LOG" 2>/dev/null || LOG=/dev/null

missing() { echo "MISSING: $1"; exit 1; }

if [ "${1:-}" = "--save" ]; then
  timeout 900 node "$ROOT/scripts/codex/auth-store.js" save >>"$LOG" 2>&1 && { echo SAVED; exit 0; }
  echo "SAVE-FAILED (log: $LOG)"; exit 1
fi

have=""
command -v codex >/dev/null 2>&1 && have="$(codex --version 2>/dev/null | awk '{print $NF}')"
# The pin is enforced only in cloud containers; on the Mac a different, owner-installed
# Codex is left alone (only a missing CLI is installed).
if [ -z "$have" ] || { [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ "$have" != "$PIN" ]; }; then
  command -v npm >/dev/null 2>&1 || missing "no npm to install @openai/codex@$PIN"
  timeout 240 npm i -g --no-audit --no-fund "@openai/codex@$PIN" >>"$LOG" 2>&1 \
    || missing "npm install of @openai/codex@$PIN failed (log: $LOG)"
  have="$(codex --version 2>/dev/null | awk '{print $NF}')"
  [ -n "$have" ] || missing "codex --version says '${have:-nothing}', wanted $PIN"
fi

home="${CODEX_HOME:-$HOME/.codex}"
if [ -n "${OPENAI_API_KEY:-}" ] && { [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || [ ! -s "$home/auth.json" ]; }; then
  # restore is a no-op when the local login is already the newer copy; a Mac
  # login that already exists is never overwritten
  timeout 60 node "$ROOT/scripts/codex/auth-store.js" restore >>"$LOG" 2>&1 || true
fi
[ -s "$home/auth.json" ] || missing "no Codex login in $home (stored login could not be restored; needs OPENAI_API_KEY and the BRO-4799 store)"

node "$ROOT/scripts/codex/install.js" >>"$LOG" 2>&1 || missing "scripts/codex/install.js failed (log: $LOG)"
echo READY
